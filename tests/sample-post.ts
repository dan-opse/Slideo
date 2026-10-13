import type { Format, Post } from "../src/lib/schema";

type Store = typeof import("../src/lib/store");

// Fresh workspaces used to seed this editorial format and post. Tests keep
// them as a legacy fixture for editorial rendering, approval and export.
export async function seedSamplePost(store: Store): Promise<Post> {
  const format: Format = {
    id: "field-notes",
    name: "Field notes",
    description: "Thoughtful lists, one useful idea at a time.",
    instructions:
      "A strong hook, four practical insights, and a gentle call to action. Be specific and avoid hype.",
    color: "#f2f2f2",
    ink: "#0a0a0a",
    accent: "#0a0a0a",
    aspect: "portrait",
    font: "serif",
    slideCount: 6,
  };
  await store.put("format", format);
  const titles = [
    "Make room for your next good idea.",
    "Start before you feel ready.",
    "Keep one small promise.",
    "Collect what catches your eye.",
    "Leave a little unfinished.",
    "Your practice. Your pace.",
  ];
  const bodies = [
    "A small field guide to a more intentional creative practice.",
    "Set aside ten minutes. Open a page. Give yourself permission to make something imperfect.",
    "Choose a routine that fits the day you actually have, rather than the one you wish you had.",
    "A sentence, a texture, an unexpected color. Give your ideas somewhere to land.",
    "Write down your next step before you stop. Make it easy to come back tomorrow.",
    "Save this for the next time you need a fresh start.",
  ];
  return store.savePost({
    title: "Make room for your next good idea",
    topic: "A sustainable creative practice",
    brandId: "demo-brand",
    formatId: format.id,
    aspect: format.aspect,
    caption:
      "A few small ways to make space for your creative practice. What helps you come back to your work?\n\n#creativepractice #fieldnotes",
    account: "",
    plannedAt: "",
    notes: "Example content — review and adapt to your own brand.",
    flags: [],
    slides: titles.map((title, i) => ({
      id: store.uid(),
      role: i === 0 ? "hook" : i === 5 ? "cta" : "body",
      title,
      body: bodies[i],
      assetId: null,
      background: i === 5 ? "#0a0a0a" : format.color,
      ink: i === 5 ? "#fafafa" : format.ink,
      accent: format.accent,
      font: format.font,
      align: "left",
      position: "center",
      fontSize: 82,
      overlay: 0.35,
    })),
  });
}
