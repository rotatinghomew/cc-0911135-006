import { readFile } from 'node:fs/promises';
import { serve, text } from '../lib/http.mjs';
const html = await readFile(new URL('../data/bulletin.html', import.meta.url), 'utf8');
export async function createSite(port = 0) {
  return serve(({ response, url, state }) => {
    if (url.pathname !== '/bulletin') return false;
    let selected = html;
    if (state.layout === 'badspan') selected = html.replace('colspan="2"', 'colspan="0"');
    if (state.layout === 'missing') selected = html.replace('<th>单位</th>', '<th>备注</th>');
    if (state.layout === 'unit-conflict') selected = html.replace('<td>mg/kg</td>', '<td>毫升</td>');
    if (state.encoding === 'windows-1252') {
      const alternate = '<html><meta charset="windows-1252"><table id="assays"><tr><th>Accession</th><th>Ni (µg/g)</th></tr><tr><td>M-008</td><td>0.5</td></tr></table></html>';
      text(response, 200, Buffer.from(alternate, 'latin1'), { 'content-type': 'text/html; charset=windows-1252' }); return true;
    }
    text(response, 200, selected, { 'content-type': 'text/html; charset=utf-8', etag: `"${state.layout}"` });
    return true;
  }, { layout: 'normal', encoding: 'utf-8' }, port);
}
