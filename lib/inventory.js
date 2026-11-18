function normalizeLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function findMatchingProduct(products, game, name) {
  const normalizedGame = normalizeLabel(game);
  const normalizedName = normalizeLabel(name);
  return products.find(product =>
    normalizeLabel(product.game) === normalizedGame &&
    normalizeLabel(product.name) === normalizedName
  );
}

function appendAccounts(product, accounts) {
  if (!Array.isArray(product.accounts)) product.accounts = [];
  product.accounts.push(...accounts);
  product.status = product.accounts.length ? "available" : "sold";
  return product.accounts.length;
}

module.exports = { appendAccounts, findMatchingProduct };
