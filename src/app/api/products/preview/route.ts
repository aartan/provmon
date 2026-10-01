import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import { resolveRetailerUrl } from "@/modules/retailers/core/retailer-resolver";
import { productDetailsSchema } from "@/modules/retailers/core/schemas";
import { intervalOptionsForRetailer } from "@/modules/monitoring/service";

const bodySchema = z.object({
  url: z.string().trim().min(1),
});

/** Preview a product URL: retailer + normalised details, before subscribing. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  registerBuiltInAdapters();

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const { adapter, parsed } = resolveRetailerUrl(body.url);
    const details = await adapter.getProduct(parsed.url);
    const validated = productDetailsSchema.parse(details);

    return NextResponse.json({
      retailer: {
        id: adapter.id,
        name: adapter.name,
      },
      product: {
        retailerProductId: validated.retailerProductId ?? null,
        name: validated.name,
        url: validated.url,
        imageUrl: validated.imageUrl ?? null,
        currency: validated.currency,
        priceMinor: validated.priceMinor ?? null,
        availability: validated.availability,
      },
      intervalOptions: intervalOptionsForRetailer(adapter.id),
    });
  } catch (error) {
    logger.warn({ component: "api", err: error }, "product preview failed");
    const message =
      error instanceof Error && error.name === "UnsupportedRetailerError"
        ? "This retailer is not supported yet. Please check the URL and try again."
        : "Could not load the product. Please check the URL and try again.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
