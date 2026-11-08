import {
  InvalidProductUrlError,
  ProductNotFoundError,
} from "@provmon/retailer-plugin-sdk";

const DOMAIN = "example-retailer.test";

function productUrl(id) {
  return `https://${DOMAIN}/products/${encodeURIComponent(id)}`;
}

function parse(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidProductUrlError("example", url);
  }
  if (parsed.hostname !== DOMAIN) {
    throw new InvalidProductUrlError("example", url);
  }
  const match = parsed.pathname.match(/^\/products\/([^/]+)\/?$/);
  if (!match) {
    throw new InvalidProductUrlError("example", url);
  }
  return decodeURIComponent(match[1]);
}

function details(id, priceMinor) {
  return {
    retailerId: "example",
    retailerProductId: id,
    name: `Example product ${id}`,
    url: productUrl(id),
    currency: "GBP",
    priceMinor,
    availability: "IN_STOCK",
    lastUpdated: new Date(),
  };
}

const examplePlugin = {
  create({ config, logger }) {
    logger.info({ plugin: "example" }, "creating example plugin");
    return {
      parseProductUrl(url) {
        return { retailerProductId: parse(url), url };
      },

      async getProduct(url) {
        const id = parse(url);
        if (id === "missing") {
          throw new ProductNotFoundError("example", id);
        }
        if (id === "invalid") {
          return {
            ...details(id, 1000),
            retailerId: "not-example",
          };
        }
        return details(id, Number(config.priceMinor));
      },

      catalogue: {
        pageSize: 2,
        async fetchPage(cursor) {
          if (cursor === "done") {
            return { items: [], nextCursor: null };
          }
          return {
            items: [details("catalogue-valid", 500), {
              ...details("catalogue-invalid", 500),
              currency: "USD",
            }],
            nextCursor: "done",
            totalEstimate: 2,
            progress: 0.5,
          };
        },
      },
    };
  },
};

export default examplePlugin;
