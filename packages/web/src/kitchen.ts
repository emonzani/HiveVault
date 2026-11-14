import { mount } from "svelte";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import Kitchen from "./kitchen/Kitchen.svelte";

mount(Kitchen, { target: document.getElementById("app")! });
