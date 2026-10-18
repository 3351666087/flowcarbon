import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FlowCarbon",
    short_name: "FlowCarbon",
    description: "Occupancy-driven after-hours energy management for office buildings.",
    start_url: "/",
    display: "standalone",
    background_color: "#0d1117",
    theme_color: "#0d1117",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
