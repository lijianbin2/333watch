import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shared = fs.readFileSync(path.join(root, 'shared/constants.js'), 'utf8');
const files = ['background.js', 'add-monitor.js', 'picker.js', 'offscreen.js'];
const keys = ['DEFAULT_INTERVAL','INVALID_THRESHOLD','FETCH_TIMEOUT_MS','MAX_HTML_BYTES','MAX_TEXT_VALUE_CHARS','MAX_URL_VALUE_CHARS','CLAIM_WINDOW_MULTI_MS','CLAIM_WINDOW_SINGLE_MS'];

function extractConstants(source) {
  const out = {};
  for (const k of keys) {
    const m = source.match(new RegExp('(?:const|export const)\s+'+k+'\s*=\s*([^;\\n]+)'));
    if (m) out[k] = m[1].trim().replace(/\/\/.*$/, '').trim();
  }
  return out;
}

const sharedVals = extractConstants(shared);
let ok = true;
for (const f of files) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  const vals = extractConstants(src);
  for (const k of keys) {
    if (!vals[k]) continue; // 文件未定义该常量则跳过
    if (vals[k] !== sharedVals[k]) {
      console.error('[check-constants] mismatch: '+f+' '+k+' => '+vals[k]+' vs shared '+sharedVals[k]);
      ok = false;
    }
  }
}
if (ok) console.log('[check-constants] all checked constants in sync with shared/constants.js');
else process.exit(1);