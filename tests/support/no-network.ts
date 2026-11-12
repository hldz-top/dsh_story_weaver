/** Fail closed if an offline test reaches a network URL. */
const nativeFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (/^https?:/i.test(url)) throw new Error(`Offline test blocked a network fetch to ${url}`)
  return nativeFetch(input, init)
}) as typeof fetch
