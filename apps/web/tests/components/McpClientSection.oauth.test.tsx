// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClientSection } from '../../src/components/McpClientSection';
import {I18nProvider} from '../../src/i18n';

const company=vi.hoisted(()=>({enabled:false,isMember:false}));
vi.mock('../../src/company/CompanyProvider',()=>({useCompany:()=>company}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('McpClientSection OAuth controls', () => {
  beforeEach(() => {
    company.enabled=false;company.isMember=false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/mcp/servers')) {
        return jsonResponse({
          servers: [
            {
              id: 'figma-use',
              label: 'figma-use',
              templateId: 'figma-use',
              transport: 'http',
              enabled: true,
              url: 'http://localhost:38451/mcp',
            },
          ],
          templates: [],
        });
      }
      if (url.startsWith('/api/mcp/oauth/status')) {
        return jsonResponse({ connected: false });
      }
      return jsonResponse({});
    }));
  });

  it('explains administrator-managed MCP to members without fetching global credentials or reporting a daemon outage', async()=>{
    company.enabled=true;company.isMember=true;
    const fetchMock=vi.fn(async()=>Response.json({error:'Administrator access required'},{status:403}));
    vi.stubGlobal('fetch',fetchMock);
    render(<I18nProvider initial="en"><McpClientSection/></I18nProvider>);
    expect(await screen.findByText('Models, providers, and server settings are managed by your administrator.')).toBeTruthy();
    expect(screen.queryByRole('button',{name:/Add server/i})).toBeNull();
    expect(screen.queryByText(/daemon.*running|Not forwarded to/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains the original MCP configuration and save flow for company administrators',async()=>{
    company.enabled=true;
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>Response.json(String(input)==='/api/mcp/servers'?{servers:init?.body?JSON.parse(String(init.body)).servers:[],templates:[]}:{agents:[]}));
    vi.stubGlobal('fetch',fetchMock);
    render(<I18nProvider initial="en"><McpClientSection/></I18nProvider>);
    fireEvent.click(await screen.findByRole('button',{name:/Add server/i}));
    fireEvent.click(screen.getByRole('button',{name:/Custom server/i}));
    fireEvent.click(screen.getByRole('button',{name:/Expand this MCP server/i}));
    fireEvent.change(screen.getByLabelText('Transport'),{target:{value:'http'}});
    fireEvent.change(screen.getByLabelText('URL'),{target:{value:'http://mcp.test/mcp'}});
    fireEvent.click(screen.getByRole('button',{name:/Save changes/i}));
    await waitFor(()=>expect(fetchMock.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(true));
    const [,init]=fetchMock.mock.calls.find(([,init])=>init?.method==='PUT')!;
    expect(JSON.parse(String(init?.body)).servers[0]).toMatchObject({transport:'http',url:'http://mcp.test/mcp',enabled:true});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does not force managed OAuth for saved localhost HTTP MCP servers', async () => {
    render(<McpClientSection />);

    const expand = await screen.findByRole('button', {
      name: /Expand this MCP server/i,
    });
    fireEvent.click(expand);

    await waitFor(() => {
      expect(screen.getAllByText(/No managed OAuth/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: /^Connect$/i })).toBeNull();
  });

  it('infers no managed OAuth when a custom HTTP row is pointed at localhost', async () => {
    render(<McpClientSection />);

    fireEvent.click(await screen.findByRole('button', { name: /Add server/i }));
    fireEvent.click(screen.getByRole('button', { name: /Custom server/i }));
    const expandButtons = screen.getAllByRole('button', {
      name: /Expand this MCP server/i,
    });
    fireEvent.click(expandButtons[expandButtons.length - 1]!);

    fireEvent.change(screen.getByLabelText('Transport'), {
      target: { value: 'http' },
    });
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'http://localhost:38451/mcp' },
    });

    await waitFor(() => {
      expect((screen.getByLabelText('OAuth mode') as HTMLSelectElement).value).toBe(
        'none',
      );
    });
    expect(screen.queryByRole('button', { name: /^Connect$/i })).toBeNull();
  });
});
