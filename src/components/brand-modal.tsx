"use client";
import type { Brand } from "@/lib/schema";
import { Field, Modal } from "./studio-ui";

export const blankBrand = {
  name: "",
  product: "",
  audience: "",
  tone: "Warm, practical, specific",
  facts: "",
  prohibited: "No invented results, testimonials, or statistics.",
  destination: "",
};

export function BrandModal({
  brand,
  busy,
  error,
  onClose,
  onSave,
}: {
  brand: Partial<Brand>;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
}) {
  return (
    <Modal
      title={brand.id ? "Your brand, in a few words." : "Meet your brand."}
      onClose={onClose}
      error={error}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          onSave({ id: brand.id, ...Object.fromEntries(f) });
        }}
      >
        {(
          [
            ["name", "Brand name", 80],
            ["product", "What do you offer?", 2000],
            ["audience", "Who is it for?", 1000],
            ["tone", "Voice & tone", 300],
            ["facts", "Verified product facts", 3000],
            ["prohibited", "Claims to avoid", 1000],
            ["destination", "Destination / website", 500],
          ] as const
        ).map(([key, label, maxLength]) => (
          <Field
            key={key}
            label={label}
            hint={
              key === "destination"
                ? "A full web address, such as https://example.com"
                : undefined
            }
          >
            {key === "name" || key === "tone" || key === "destination" ? (
              <input
                name={key}
                type={key === "destination" ? "url" : "text"}
                maxLength={maxLength}
                defaultValue={String(brand[key] || "")}
                required={key === "name"}
              />
            ) : (
              <textarea
                name={key}
                rows={2}
                maxLength={maxLength}
                defaultValue={String(brand[key] || "")}
              />
            )}
          </Field>
        ))}
        <div className="modal-actions">
          <button disabled={busy} className="button primary">
            Save brand brief
          </button>
        </div>
      </form>
    </Modal>
  );
}
