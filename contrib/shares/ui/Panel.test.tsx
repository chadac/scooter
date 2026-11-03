/** The Shares section: the broker's listing body mapped to rows, and the list it renders. */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { parseShares, SharesList } from "./Panel.js";

const UUID = "7f3c2a1e-1b2c-4d5e-8f90-abcdef012345";

describe("parseShares", () => {
  it("maps the snake_case listing and defaults missing fields", () => {
    const rows = parseShares({ shares: [{ uuid: UUID, url: `/s/${UUID}/`, latest_version: 3 }] });
    expect(rows).toEqual([{ uuid: UUID, url: `/s/${UUID}/`, description: "", latestVersion: 3, updatedAt: "" }]);
  });

  it("drops malformed rows and tolerates a body of the wrong shape", () => {
    expect(parseShares({ shares: [{ uuid: UUID }, null, { uuid: UUID, url: "/s/x/" }] })).toHaveLength(1);
    expect(parseShares(null)).toEqual([]);
    expect(parseShares({ shares: "nope" })).toEqual([]);
  });
});

describe("SharesList", () => {
  it("shows the empty state with no shares", () => {
    expect(renderToStaticMarkup(<SharesList shares={[]} />)).toContain('data-testid="shares-empty"');
  });

  it("links each share, labelled by its description", () => {
    const html = renderToStaticMarkup(
      <SharesList shares={[{ uuid: UUID, url: `/s/${UUID}/`, description: "chart", latestVersion: 2, updatedAt: "" }]} />,
    );
    expect(html).toContain(`href="/s/${UUID}/"`);
    expect(html).toContain(">chart<");
    expect(html).toContain("v2");
  });
});
