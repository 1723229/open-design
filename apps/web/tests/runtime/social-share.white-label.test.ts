import { describe, expect, it } from 'vitest';
import { buildSocialSharePayload } from '@open-design/contracts';
import { tForLanguageTag } from '../../src/i18n';
import { LOCALES } from '../../src/i18n/types';

describe('project social sharing', () => {
  it.each(LOCALES)('shares the project without upstream promotion in %s', (locale) => {
    const t = tForLanguageTag(locale)!;
    const title = 'Example project';
    const url = 'https://example.com/project';
    const payload = buildSocialSharePayload({
      kind: 'project-html',
      locale,
      url,
      title: t('socialShare.projectTitle', { title }),
      text: t('socialShare.projectText', { title }),
      copyText: t('socialShare.projectCopyText', { title, url }),
    });

    expect(payload.text).toContain(title);
    expect(payload.copyText).toContain(url);
    for (const text of [payload.text, payload.copyText, ...payload.platforms.map((item) => decodeURIComponent(item.shareUrl ?? ''))]) {
      expect(text).not.toMatch(/\{repo\}|github\.com|OpenDesign|Open Design/);
    }
  });
});
