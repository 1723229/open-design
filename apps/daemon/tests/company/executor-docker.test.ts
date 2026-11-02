import { afterEach, expect, it, vi } from 'vitest';
import { removeCompanyContainers } from '../../src/company/executor-docker.js';

afterEach(() => vi.useRealTimers());

it('waits for concurrent container removal to finish', async () => {
  vi.useFakeTimers();
  const remove = vi.fn()
    .mockRejectedValueOnce({ stderr: 'Error response from daemon: removal of container abc is already in progress\n' })
    .mockRejectedValueOnce({ stderr: 'Error response from daemon: No such container: abc\n' });
  const pending = removeCompanyContainers(['abc'], remove);
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toBeUndefined();
  expect(remove).toHaveBeenCalledTimes(2);
});

it('accepts a batch only when every remaining error confirms the container is absent', async () => {
  const remove = vi.fn().mockRejectedValue({ stderr: 'Error response from daemon: No such container: abc\nError response from daemon: No such container: def\n' });
  await removeCompanyContainers(['abc', 'def'], remove);
  expect(remove).toHaveBeenCalledExactlyOnceWith(['abc', 'def']);
});

it('does not swallow Docker errors that leave removal unconfirmed', async () => {
  const error = { stderr: 'Error response from daemon: No such container: abc\nCannot connect to the Docker daemon\n' };
  await expect(removeCompanyContainers(['abc', 'def'], vi.fn().mockRejectedValue(error))).rejects.toBe(error);
});

it('bounds the wait when Docker remains stuck removing a container', async () => {
  vi.useFakeTimers();
  const error = { stderr: 'Error response from daemon: removal of container abc is already in progress\n' };
  const remove = vi.fn().mockRejectedValue(error);
  const pending = expect(removeCompanyContainers(['abc'], remove)).rejects.toBe(error);
  await vi.runAllTimersAsync();
  await pending;
  expect(remove).toHaveBeenCalledTimes(50);
});

it('does not invoke Docker for an empty cleanup', async () => {
  const remove = vi.fn();
  await removeCompanyContainers([], remove);
  expect(remove).not.toHaveBeenCalled();
});
