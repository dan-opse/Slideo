import type { PhotoText, Post, RoleTemplate, Slide } from "@/lib/schema";
import { roleNames } from "@/lib/format-template";
import type { DropdownItem } from "./ui/dropdown";

// Dropdown option lists shared by the format dashboard and the slideshow
// editor.
export const canvasItems: DropdownItem<Post["aspect"]>[] = [
  { value: "story", label: "9:16", hint: "1080 × 1920" },
  { value: "portrait", label: "4:5", hint: "1080 × 1350" },
];

export const fontItems: DropdownItem<PhotoText["font"]>[] = [
  { value: "default", label: "Default" },
  { value: "semibold", label: "Semibold" },
  { value: "regular", label: "Regular" },
];

export const styleItems: DropdownItem<PhotoText["style"]>[] = [
  { value: "outline", label: "Outline" },
  { value: "plain", label: "Plain" },
  { value: "shadow", label: "Shadow" },
  { value: "box", label: "Background" },
];

export const positionItems: DropdownItem<RoleTemplate["position"]>[] = [
  { value: "top", label: "Top" },
  { value: "center", label: "Center" },
  { value: "bottom", label: "Bottom" },
];

export const roleItems: DropdownItem<Slide["role"]>[] = (
  Object.keys(roleNames) as Slide["role"][]
).map((value) => ({ value, label: roleNames[value] }));
