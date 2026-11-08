import {
  catalogueDiscoveryPageEnvelopeSchema,
  isRetailerError,
  parsedProductUrlSchema,
  productDetailsSchema,
  RetailerParseError,
  type CatalogueDiscovery,
  type CatalogueDiscoveryPage,
  type ParsedProductUrl,
  type PluginLogger,
  type ProductDetails,
  type RetailerPluginInstance,
} from "@provmon/retailer-plugin-sdk";

import type { RetailerAdapter } from "@/modules/retailers/core/adapter.interface";
import { hostnameMatches } from "@/modules/retailers/core/retailer-registry";

import type { PluginPackageDescriptor } from "./discovery";

/**
 * Adapts an external plugin instance to the internal RetailerAdapter
 * interface. Every value crossing the boundary is validated here, so a
 * buggy plugin cannot write unnormalised data into the catalogue or
 * monitoring engines.
 */
export class PluginRetailerAdapter implements RetailerAdapter {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly supportedDomains: string[];
  readonly minCheckIntervalMs: number;
  readonly currency: string;
  readonly treatNotFoundAsOutOfStock: boolean;
  readonly catalogue?: CatalogueDiscovery;

  private readonly maxCataloguePageItems: number;

  constructor(
    private readonly descriptor: PluginPackageDescriptor,
    private readonly instance: RetailerPluginInstance,
    private readonly logger: PluginLogger,
  ) {
    const { manifest } = descriptor;
    this.id = manifest.id;
    this.name = manifest.name;
    this.version = descriptor.version;
    this.supportedDomains = manifest.supportedDomains;
    this.minCheckIntervalMs = manifest.minCheckIntervalMs;
    this.currency = manifest.currency;
    this.treatNotFoundAsOutOfStock = manifest.treatNotFoundAsOutOfStock;
    this.maxCataloguePageItems =
      manifest.limits?.maxCataloguePageItems ?? 20_000;

    if (instance.catalogue) {
      const source = instance.catalogue;
      this.catalogue = {
        ...(typeof source.pageSize === "number" && source.pageSize > 0
          ? { pageSize: source.pageSize }
          : {}),
        fetchPage: (cursor) => this.fetchCataloguePage(source, cursor),
      };
    }
  }

  parseProductUrl(url: string): ParsedProductUrl {
    let parsed: ParsedProductUrl;
    try {
      parsed = this.instance.parseProductUrl(url);
    } catch (error) {
      this.rethrow(error);
    }

    const validated = parsedProductUrlSchema.safeParse(parsed);
    if (!validated.success) {
      this.logger.warn(
        { pluginId: this.id, issues: validated.error.issues },
        "plugin returned an invalid parsed product URL",
      );
      throw new RetailerParseError(this.id, validated.error);
    }

    this.assertProductUrl(validated.data.url);
    return validated.data;
  }

  async getProduct(url: string): Promise<ProductDetails> {
    let raw: ProductDetails;
    try {
      raw = await this.instance.getProduct(url);
    } catch (error) {
      this.rethrow(error);
    }
    return this.validateProductDetails(raw);
  }

  private async fetchCataloguePage(
    source: CatalogueDiscovery,
    cursor: string | null,
  ): Promise<CatalogueDiscoveryPage> {
    let raw: CatalogueDiscoveryPage;
    try {
      raw = await source.fetchPage(cursor);
    } catch (error) {
      this.rethrow(error);
    }

    const envelope = catalogueDiscoveryPageEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new RetailerParseError(this.id, envelope.error);
    }

    if (envelope.data.items.length > this.maxCataloguePageItems) {
      throw new RetailerParseError(
        this.id,
        new Error(
          `Catalogue page has ${envelope.data.items.length} items; maximum is ${this.maxCataloguePageItems}`,
        ),
      );
    }

    if (
      envelope.data.nextCursor !== null &&
      envelope.data.nextCursor === cursor
    ) {
      throw new RetailerParseError(
        this.id,
        new Error("Catalogue cursor did not advance"),
      );
    }

    const items: ProductDetails[] = [];
    let rejected = 0;
    for (const rawItem of envelope.data.items) {
      try {
        items.push(this.validateProductDetails(rawItem));
      } catch {
        rejected += 1;
      }
    }
    if (rejected > 0) {
      this.logger.warn(
        { pluginId: this.id, rejected, cursor },
        "dropped invalid products from a plugin catalogue page",
      );
    }

    return {
      items,
      nextCursor: envelope.data.nextCursor,
      totalEstimate: envelope.data.totalEstimate,
      progress: envelope.data.progress,
    };
  }

  private validateProductDetails(raw: unknown): ProductDetails {
    const validated = productDetailsSchema.safeParse(raw);
    if (!validated.success) {
      this.logger.warn(
        { pluginId: this.id, issues: validated.error.issues },
        "plugin returned invalid product details",
      );
      throw new RetailerParseError(this.id, validated.error);
    }

    const details = validated.data;
    if (details.retailerId !== this.id) {
      throw new RetailerParseError(
        this.id,
        new Error(
          `Plugin returned retailerId "${details.retailerId}" for ${this.id}`,
        ),
      );
    }
    if (details.currency !== this.currency) {
      throw new RetailerParseError(
        this.id,
        new Error(
          `Plugin returned currency "${details.currency}" but declares "${this.currency}"`,
        ),
      );
    }
    this.assertProductUrl(details.url);
    return details;
  }

  private assertProductUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new RetailerParseError(this.id, new Error("Invalid product URL"));
    }
    const matchesDomain = this.supportedDomains.some((domain) =>
      hostnameMatches(parsed.hostname, domain),
    );
    if (!matchesDomain) {
      throw new RetailerParseError(
        this.id,
        new Error(
          `Product URL hostname "${parsed.hostname}" is outside the plugin's supported domains`,
        ),
      );
    }
  }

  private rethrow(error: unknown): never {
    if (isRetailerError(error)) {
      throw error;
    }
    this.logger.error(
      { pluginId: this.id, err: error },
      "plugin threw an untyped error",
    );
    throw new RetailerParseError(this.id, error);
  }
}
