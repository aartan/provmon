import type { Metadata } from "next";

import { AddInventoryForm } from "@/app/(app)/inventory/add/add-inventory-form";

export const metadata: Metadata = {
  title: "Add to inventory",
};

export default function AddInventoryPage() {
  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Add to inventory</h1>
        <p className="text-sm text-muted-foreground">
          Save a product from any supported retailer. You can start monitoring
          one or more of its retailer listings afterwards — inventory does not
          require monitoring.
        </p>
      </div>
      <AddInventoryForm />
    </div>
  );
}
