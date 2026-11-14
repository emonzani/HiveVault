<script lang="ts" module>
  // Line icons on a 20px grid, stroke = currentColor. Drawn for this app (no icon font).
  const PATHS: Record<string, string> = {
    sidebar: "M3.5 4.5h13v11h-13z M8 4.5v11",
    search: "M8.5 3.5a5 5 0 1 1 0 10a5 5 0 0 1 0-10z M12.2 12.2l4.3 4.3",
    switch: "M4 6h9 M10 3l3 3l-3 3 M16 14H7 M10 11l-3 3l3 3",
    graph: "M5 5.5a1.5 1.5 0 1 1 0 .01 M15 4.5a1.5 1.5 0 1 1 0 .01 M10 14.5a1.5 1.5 0 1 1 0 .01 M6.3 6.4l3 6.6 M13.8 5.6l-3 7.6 M6.5 5.2l7-0.6",
    inbox: "M3.5 11.5l2-7h9l2 7v4h-13z M3.5 11.5h4l1 2h3l1-2h4",
    plus: "M10 4v12 M4 10h12",
    upload: "M10 13V4 M6.5 7.5L10 4l3.5 3.5 M4 13v3h12v-3",
    command: "M7 4.5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v11a2 2 0 1 0 2-2H5a2 2 0 1 0 2 2z",
    agent: "M10 3.5l1.6 4.9h5.1l-4.1 3l1.6 4.9L10 13.3l-4.2 3l1.6-4.9l-4.1-3h5.1z",
    user: "M10 10a3 3 0 1 0 0-6a3 3 0 0 0 0 6z M4.5 16.5c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5",
    chevron: "M7.5 5l5 5l-5 5",
    close: "M5.5 5.5l9 9 M14.5 5.5l-9 9",
    edit: "M4 16l1-4l8-8l3 3l-8 8z M11.5 5.5l3 3",
    eye: "M2.5 10s3-5.5 7.5-5.5S17.5 10 17.5 10s-3 5.5-7.5 5.5S2.5 10 2.5 10z M10 12.2a2.2 2.2 0 1 0 0-4.4a2.2 2.2 0 0 0 0 4.4z",
    star: "M10 3.5l1.9 4l4.4.5l-3.3 3l.9 4.4L10 13.2l-3.9 2.2l.9-4.4l-3.3-3l4.4-.5z",
    history: "M4 10a6 6 0 1 0 1.8-4.3 M4 4v3h3 M10 7v3.5l2.5 1.5",
    split: "M3.5 4.5h13v11h-13z M10 4.5v11",
    back: "M12 5l-5 5l5 5",
    forward: "M8 5l5 5l-5 5",
    more: "M5 10h.01 M10 10h.01 M15 10h.01",
    file: "M5.5 3.5h6l3 3v10h-9z M11.5 3.5v3h3",
    link: "M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8 M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8A3 3 0 0 0 9.2 15l.8-.8",
    download: "M10 4v9 M6.5 9.5L10 13l3.5-3.5 M4 16h12",
    trash: "M4.5 6h11 M8 6V4h4v2 M6 6l.7 10h6.6L14 6",
    refresh: "M15.5 8A6 6 0 0 0 4.6 7 M4.5 3.5V7H8 M4.5 12a6 6 0 0 0 10.9 1 M15.5 16.5V13H12",
    check: "M4.5 10.5l3.5 3.5l7.5-8",
    alert: "M10 3.5l7 12.5H3z M10 8.5v3.5 M10 14.2v.01",
    outline: "M4 5h12 M6.5 10h9.5 M9 15h7",
    backlink: "M8 6l-4 4l4 4 M4 10h8a4 4 0 0 1 4 4v1",
    props: "M4 5h3 M9 5h7 M4 10h6 M12 10h4 M4 15h2 M8 15h8",
    logout: "M8 4H4.5v12H8 M12 6.5L15.5 10L12 13.5 M15.5 10H7.5",
    moon: "M15.5 12.5A6 6 0 0 1 7.5 4.5a6 6 0 1 0 8 8z",
    key: "M7 12.5a3.5 3.5 0 1 1 0-7a3.5 3.5 0 0 1 0 7z M10.3 9H17v3 M14.5 9v2.5",
    shield: "M10 3l6 2.2v4.3c0 3.6-2.6 6.2-6 7.5c-3.4-1.3-6-3.9-6-7.5V5.2z M7.5 10l2 2l3.5-3.8",
    task: "M4 5.5h1.5 M8 5.5h8 M4 10h1.5 M8 10h8 M4 14.5h1.5 M8 14.5h8",
    cpu: "M6 6h8v8H6z M8.5 8.5h3v3h-3z M8 3.5V6 M12 3.5V6 M8 14v2.5 M12 14v2.5 M3.5 8H6 M3.5 12H6 M14 8h2.5 M14 12h2.5",
    settings: "M10 12.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 0 0 0 5z M10 2.8v2 M10 15.2v2 M2.8 10h2 M15.2 10h2 M4.9 4.9l1.4 1.4 M13.7 13.7l1.4 1.4 M4.9 15.1l1.4-1.4 M13.7 6.3l1.4-1.4",
    database: "M4.5 5c0-1.1 2.5-2 5.5-2s5.5.9 5.5 2s-2.5 2-5.5 2s-5.5-.9-5.5-2z M4.5 5v10c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V5 M4.5 10c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2",
    gauge: "M3.5 14a6.5 6.5 0 1 1 13 0 M10 14l3.2-4.2 M10 14.01h.01",
    console: "M3.5 4.5h13v11h-13z M6.5 8.5l2 1.5l-2 1.5 M10.5 12h3",
    play: "M6.5 4.5v11l9-5.5z",
    stop: "M5.5 5.5h9v9h-9z",
    hive: "M10 3l3 1.75v3.5L10 10L7 8.25v-3.5z M6.5 9.75l3 1.75v3.5l-3 1.75l-3-1.75V11.5z M13.5 9.75l3 1.75v3.5l-3 1.75l-3-1.75V11.5z",
  };
</script>

<script lang="ts">
  let { name, size = 18 }: { name: string; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={PATHS[name] ?? ""} />
</svg>
