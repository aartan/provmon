import type { Metadata } from "next";

import { AddProductForm } from "@/app/(app)/products/add/add-product-form";

export const metadata: Metadata = {
  title: "Add product",
};

export default function AddProductPage() {
  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add a product</h1>
        <p className="text-sm text-muted-foreground">
          Paste a product URL from a supported retailer. We will fetch the current
          price and stock, and you can pick your notification conditions.
        </p>
      </div>
      <AddProductForm />
    </div>
  );
}
