import { mount } from "svelte";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import { loadLocale } from "./lib/i18n.ts";

// The catalog loads before the app module: tables built at import time use t() too.
await loadLocale();
const { default: App } = await import("./app/App.svelte");
mount(App, { target: document.getElementById("app")! });
