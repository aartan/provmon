/**
 * Fixtures captured from the live CeX Algolia search index
 * (search.webuy.io multi-query endpoint), trimmed to the fields
 * the adapter consumes. Note the image URLs contain literal spaces, as
 * returned by the API.
 */
export const inStockHitFixture = {
  results: [
    {
      hits: [
        {
          boxId: "SLAPAPPMP16146SGB",
          boxName:
            'MacBook Pro 16,1/i9-9880H/16GB/1TB SSD/5500M 4GB/16"/SG/B',
          sellPrice: 510,
          ecomQuantity: 4,
          collectionQuantity: 4,
          discontinued: 0,
          imageUrls: {
            large: "https://uk.static.webuy.com/product_images/Computing/Laptops - Apple Mac/SLAPAPPMP16146SGB_l.jpg",
            medium: "https://uk.static.webuy.com/product_images/Computing/Laptops - Apple Mac/SLAPAPPMP16146SGB_m.jpg",
            small: "https://uk.static.webuy.com/product_images/Computing/Laptops - Apple Mac/SLAPAPPMP16146SGB_s.jpg",
          },
        },
      ],
      nbHits: 1,
    },
  ],
};

/** A hit with zero units everywhere: in stock nowhere. */
export const outOfStockEverywhereHitFixture = {
  results: [
    {
      hits: [
        {
          boxId: "SLAPAPPMP16146SGB",
          boxName:
            'MacBook Pro 16,1/i9-9880H/16GB/1TB SSD/5500M 4GB/16"/SG/B',
          sellPrice: 510,
          ecomQuantity: 0,
          collectionQuantity: 0,
          discontinued: 0,
          imageUrls: {
            large: "https://uk.static.webuy.com/product_images/Computing/Laptops - Apple Mac/SLAPAPPMP16146SGB_l.jpg",
          },
        },
      ],
      nbHits: 1,
    },
  ],
};

/** A hit flagged discontinued (no longer sold). */
export const discontinuedHitFixture = {
  results: [
    {
      hits: [
        {
          boxId: "SLAPAPPMP16146SGB",
          boxName:
            'MacBook Pro 16,1/i9-9880H/16GB/1TB SSD/5500M 4GB/16"/SG/B',
          sellPrice: 510,
          ecomQuantity: 2,
          collectionQuantity: 2,
          discontinued: 1,
          imageUrls: {
            large: "https://uk.static.webuy.com/product_images/Computing/Laptops - Apple Mac/SLAPAPPMP16146SGB_l.jpg",
          },
        },
      ],
      nbHits: 1,
    },
  ],
};

/** What the API returns for a box id that no longer exists. */
export const emptyResultsFixture = {
  results: [
    {
      hits: [],
      nbHits: 0,
    },
  ],
};
