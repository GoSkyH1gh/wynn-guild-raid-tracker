import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  mountCyclePicker,
  type CyclePickerOption,
} from "./src/cycle-picker.ts";

const results: string[] = [];

GlobalRegistrator.register();

const root = document.createElement("div");
document.body.appendChild(root);

const options: CyclePickerOption[] = [
  {
    index: 0,
    title: "Cycle 0",
    dates: "Jul 17 – Jul 26",
    status: "closed",
    hasData: false,
    isSelected: false,
  },
  {
    index: 1,
    title: "Cycle 1",
    dates: "Jul 27 – Aug 2",
    status: "open",
    hasData: true,
    isSelected: false,
  },
  {
    index: 2,
    title: "Cycle 2",
    dates: "Aug 3 – Aug 9",
    status: "current",
    hasData: true,
    isSelected: true,
  },
];

const selects: number[] = [];
const destroy = mountCyclePicker(root, options, (i) => selects.push(i));

const trigger = root.querySelector(".cp-trigger") as HTMLButtonElement;
const menu = root.querySelector(".cp-menu") as HTMLElement;

results.push(`initial: hidden=${menu.hidden}, expanded=${trigger.getAttribute("aria-expanded")}`);

trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
results.push(
  `after Enter: hidden=${menu.hidden}, expanded=${trigger.getAttribute("aria-expanded")}, activedescendant=${menu.getAttribute("aria-activedescendant")}`,
);

const itemEls = [...menu.querySelectorAll(".cp-item")] as HTMLElement[];
const sections = [...menu.querySelectorAll(".cp-section-label")].map((el) => el.textContent);
results.push(`items=${itemEls.length} (cycle 0 always visible), sections=${sections.join(",")}`);

trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
results.push(`after ArrowDown: highlighted=${menu.getAttribute("aria-activedescendant")}`);

trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
results.push(
  `after select Enter: selects=${JSON.stringify(selects)}, hidden=${menu.hidden}, expanded=${trigger.getAttribute("aria-expanded")}`,
);

trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
results.push(`after Esc: hidden=${menu.hidden}, expanded=${trigger.getAttribute("aria-expanded")}`);

trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
(itemEls[1] as HTMLElement).click();
results.push(`click select: selects=${JSON.stringify(selects)}, hidden=${menu.hidden}`);

const closed = root.querySelector(".cp-item[data-status='closed']") as HTMLElement | null;
results.push(`cycle 0 present in menu: ${closed !== null}`);

destroy();
results.push(`after destroy: root children=${root.childElementCount}`);

console.log(results.join("\n"));
