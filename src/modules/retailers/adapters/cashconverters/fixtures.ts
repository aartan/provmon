/**
 * Fixtures captured from the live Cash Converters search API
 * (https://www.cashconverters.co.uk/c3api/search/results), trimmed to the
 * fields the adapter consumes.
 */
export const inStockItemFixture = {
  WasSuccessful: true,
  Message: null,
  Value: {
    ProductList: {
      ProductListItemCount: 1,
      ProductListItems: [
        {
          Code: "053700239842",
          Title: "Apple Macbook Pro 15,4 Silver",
          ImageUrl: "/globalassets/catalogs/c10c5451-41fb-41a9-b3b6-b4ff00cfe6fb.jpg",
          Rrp: "299.99",
          Sp: "299.99",
          Condition: "2",
          Url: "/shop/phones-cameras--computers/tablets--laptops/laptops/laptop/053700239842",
          Category: "Laptop",
          StoreNameWithState: "Lincoln, East Midlands",
          ShippingLabel: "Postage",
          ShippingCost: "7.95",
          Promotion: null,
          ItemType: "Laptop",
          ProductList: "Tablets & Laptops",
          Brand: "Apple",
          AbsoluteImageUrl:
            "https://www.cashconverters.co.uk/globalassets/catalogs/c10c5451-41fb-41a9-b3b6-b4ff00cfe6fb.jpg",
          HasAuthenticityCertificate: false,
        },
      ],
    },
  },
};

/** Real example where Sp is below Rrp (a markdown). */
export const markedDownItemFixture = {
  WasSuccessful: true,
  Message: null,
  Value: {
    ProductList: {
      ProductListItemCount: 1,
      ProductListItems: [
        {
          Code: "048900257489",
          Title: "Apple Macbook Pro M5 Pro, 24GB Ram, 1TB SSD Storage M5 Pro 2026 Black",
          ImageUrl: null,
          Rrp: "2500.00",
          Sp: "2249.99",
          Condition: "4",
          Url: "/shop/phones-cameras--computers/tablets--laptops/laptops/apple-laptop/048900257489",
          Category: "Apple Laptop",
          StoreNameWithState: "Newcastle Upon Tyne, North East",
          ShippingLabel: "Postage",
          ShippingCost: "7.95",
          Promotion: null,
          ItemType: "Apple Laptop",
          ProductList: "Tablets & Laptops",
          Brand: "Apple",
          AbsoluteImageUrl:
            "https://www.cashconverters.co.uk/globalassets/catalogs/975884f3-449e-42aa-bd28-b4f300b1579d.jpg",
          HasAuthenticityCertificate: false,
        },
      ],
    },
  },
};

/** What the API returns for a code that no longer exists. */
export const emptyResultsFixture = {
  WasSuccessful: true,
  Message: null,
  Value: {
    ProductList: {
      ProductListItemCount: 0,
      ProductListItems: [],
    },
  },
};
