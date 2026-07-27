import { z } from "zod";

/**
 * Validates the shape of one entry in ogn.json/ogs.json (the Riftcodex API
 * export format, reused directly from the Java/C# repos per PRD decision —
 * see A:\Projects\riftbound-engine\src\main\resources\cards\ogn.json).
 * Deliberately permissive (`.passthrough()`): this gates the fields the
 * loader actually reads, not every field in the export, so upstream
 * additions don't break loading.
 */
export const RawCardSchema = z
  .object({
    riftbound_id: z.string(),
    name: z.string(),
    attributes: z
      .object({
        energy: z.number().nullable(),
        might: z.number().nullable(),
        power: z.number().nullable(),
      })
      .passthrough(),
    classification: z
      .object({
        type: z.enum(["Unit", "Spell", "Rune", "Gear", "Legend", "Battlefield"]),
        supertype: z.string().nullable(),
        rarity: z.string(),
        domain: z.array(z.string()),
      })
      .passthrough(),
    text: z
      .object({
        plain: z.string().nullable(),
      })
      .passthrough(),
    media: z
      .object({
        image_url: z.string().nullable(),
      })
      .passthrough(),
    tags: z.array(z.string()).nullable().optional(),
    metadata: z
      .object({
        alternate_art: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export type RawCard = z.infer<typeof RawCardSchema>;

/**
 * A card-set JSON file is either a bare array (ogn.json) or a paginated
 * `{items: [...]}` envelope (ogs.json) — CardLoader.java's `readItems`
 * (registry/CardLoader.java:257-272) handles both the same way.
 */
export const RawCardFileSchema = z.union([
  z.array(RawCardSchema),
  z.object({ items: z.array(RawCardSchema) }).passthrough(),
]);

export function extractCardItems(raw: unknown): RawCard[] {
  const parsed = RawCardFileSchema.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.items;
}
