function isSameOriginRequest(source, host) {
  if (!source || !host) return false;
  try {
    const url = new URL(source);
    return ["http:", "https:"].includes(url.protocol) &&
      url.host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

module.exports = { isSameOriginRequest };
