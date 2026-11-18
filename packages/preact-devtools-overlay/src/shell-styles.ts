import "./shell.css";
import { getStyles } from "./styles-registry.js";

/** CSS for the overlay chrome (launcher, drawer, tabs). */
export function shellStyles(): string {
	return getStyles("shell");
}
