import { expect, it } from "vitest";
import { CONTAINER_RESIZE_EVENT } from "../src/shared";
import { CONTAINER_RESIZE_EVENT as UPSTREAM } from "../vendor/preact-devtools/src/view/components/utils";

it("container resize event name matches the patched upstream hook", () => {
	expect(CONTAINER_RESIZE_EVENT).toBe(UPSTREAM);
});
