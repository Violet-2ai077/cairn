import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocale } from '../src/i18n/locale.mjs';

test('locale precedence and fallback are explicit and independent of the machine running tests', () => {
  for (const [env, os, expected] of [
    [{}, 'zh-Hans-CN', 'zh'], [{}, 'en-GB', 'en'],
    [{ LANG: 'zh_CN.UTF-8' }, 'en-US', 'zh'],
    [{ LANG: 'zh', LC_MESSAGES: 'en_GB' }, 'zh', 'en'],
    [{ LC_ALL: 'zh_TW.Big5', LC_MESSAGES: 'en_US' }, 'en', 'zh'],
    [{ CAIRN_LOCALE: ' EN-us ', LC_ALL: 'zh-Hans' }, 'zh', 'en'],
    [{ CAIRN_LOCALE: 'auto', LANG: 'zh-Hant' }, 'en', 'zh'],
    [{ LANG: 'C.UTF-8' }, 'zh', 'en'], [{ LANG: 'fr_CA' }, 'en', 'en'],
  ]) assert.equal(resolveLocale(env, os), expected, JSON.stringify({ env, os }));
});
