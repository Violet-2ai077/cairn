// dsh profiles and CLI invocations each select a language at process startup.
export function resolveLocale(env, systemLocale) {
  const override = env.CAIRN_LOCALE?.trim();
  const language = override && override.toLowerCase() !== 'auto' ? override :
    [env.LC_ALL, env.LC_MESSAGES, env.LANG, systemLocale].find(value => value?.trim());
  return /^zh(?:[-_.@]|$)/iu.test(language?.trim() ?? '') ? 'zh' : 'en';
}

export const runtimeLocale = resolveLocale(process.env, Intl.DateTimeFormat().resolvedOptions().locale);
export const pick = (zh, en) => runtimeLocale === 'zh' ? zh : en;
