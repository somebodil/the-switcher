import assert from "node:assert/strict";
import { describe as suite, it } from "node:test";
import { describe, FileIndex, type FileInfo } from "./file-index.ts";
import { parseQuery } from "./query.ts";

function file(path: string, options: Partial<FileInfo> = {}): FileInfo {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return {
    path,
    basename: name.slice(0, dot),
    extension: name.slice(dot + 1),
    folder: slash === -1 ? "/" : path.slice(0, slash),
    mtime: 0,
    aliases: [],
    ...options,
  };
}

const vault = [
  file("Notes/Alpha Beta.md"),
  file("Notes/alphabet soup.md"),
  file("Notes/with-alias.md", { aliases: ["Zeta", "alpha alias"] }),
  file("Notes/Albums/song.md"),
  file("Archive/alpha-old.md"),
  file("Projects/Deep/Alpha plan.md"),
  file("img/alpha.png"),
  file("root-note.md"),
];

/** Paths that a query finds, in the order of the results. */
function find(query: string, files = vault, recentPaths: string[] = []): string[] {
  return new FileIndex(files, recentPaths)
    .search(parseQuery(query))
    .map((hit) => hit.entry.file.path);
}

suite("FileIndex.search: which files match", () => {
  const cases: [query: string, expected: string[]][] = [
    // a word in the name, in an alias or in the folder path
    ["soup", ["Notes/alphabet soup.md"]],
    ["zeta", ["Notes/with-alias.md"]],
    ["deep", ["Projects/Deep/Alpha plan.md"]],
    ["png", ["img/alpha.png"]],
    ["md", []],
    // case and spaces do not matter
    ["ALPHABETA", ["Notes/Alpha Beta.md"]],
    ['"alpha beta"', ["Notes/Alpha Beta.md"]],
    // every word has to match, in any order
    ["be alpha", ["Notes/Alpha Beta.md", "Notes/alphabet soup.md"]],
    ["beta alpha", ["Notes/Alpha Beta.md"]],
    ["alpha nothing", []],
    // a word with a dash removes what it matches
    ["plan -deep", []],
    ["old -zzz", ["Archive/alpha-old.md"]],
    ["al -notes -archive", ["img/alpha.png", "Projects/Deep/Alpha plan.md"]],
    // folders before the last slash, a part of the name after it
    ["Notes/", ["Notes/Alpha Beta.md", "Notes/alphabet soup.md", "Notes/Albums/song.md", "Notes/with-alias.md"]],
    ["Notes/alphab", ["Notes/Alpha Beta.md", "Notes/alphabet soup.md"]],
    ["Notes/zeta", ["Notes/with-alias.md"]],
    ["Archive/alphab", []],
    ["Projects/Deep", ["Projects/Deep/Alpha plan.md"]],
    ["Notes/Alb", ["Notes/Albums/song.md"]],
  ];
  for (const [query, expected] of cases) {
    it(`finds ${JSON.stringify(query)}`, () => {
      assert.deepEqual(find(query), expected);
    });
  }

  it("lists every file for a query without a word", () => {
    assert.equal(find("").length, vault.length);
    assert.deepEqual(find(" - "), find(""));
    assert.deepEqual(find("/"), find(""));
  });
});

suite("FileIndex.search: order", () => {
  it("is alphabetical without a query, ignoring case and emoji", () => {
    assert.deepEqual(
      find("", [file("b/Cherry.md"), file("a/📝banana.md"), file("c/apple.md")]),
      ["c/apple.md", "a/📝banana.md", "b/Cherry.md"],
    );
  });

  it("breaks ties by Markdown, then recently opened, then recently modified", () => {
    const files = [
      file("a/note.png", { mtime: 9 }),
      file("b/note.md", { mtime: 1 }),
      file("c/note.md", { mtime: 2 }),
      file("d/note.md", { mtime: 3 }),
      file("e/note.md", { mtime: 4 }),
    ];
    assert.deepEqual(find("", files, ["x.md", "c/note.md", "b/note.md"]), [
      "c/note.md",
      "b/note.md",
      "e/note.md",
      "d/note.md",
      "a/note.png",
    ]);
  });

  it("puts names and aliases that start with more of the words first", () => {
    const files = [
      file("n/zz alpha beta.md"),
      file("n/beta alpha.md"),
      file("n/alpha beta.md"),
      file("n/other.md", { aliases: ["Alpha", "Beta"] }),
    ];
    assert.deepEqual(find("al be", files), [
      "n/other.md",
      "n/alpha beta.md",
      "n/beta alpha.md",
      "n/zz alpha beta.md",
    ]);
  });

  it("counts a word once however often it is typed", () => {
    const files = [file("n/alpha.md"), file("n/beta alpha.md", { aliases: ["Beta"] })];
    assert.deepEqual(find("al al", files), ["n/alpha.md", "n/beta alpha.md"]);
  });

  it("looks past emoji to see what a name starts with", () => {
    assert.deepEqual(find("me", [file("n/a memo.md"), file("n/📝memo.md")]), [
      "n/📝memo.md",
      "n/a memo.md",
    ]);
  });

  it("lists a file under an alias if the first word finds the alias but not the name", () => {
    const files = [
      file("n/alpha.md"),
      file("n/alpha beta.md"),
      file("n/zzz.md", { aliases: ["Xyz", "The alpha", "alpha alias"] }),
      file("n/with-al.md", { aliases: ["alpha a"] }),
    ];
    assert.deepEqual(find("alpha", files), [
      "n/alpha.md",
      // listed under "alpha a"
      "n/with-al.md",
      // listed under "alpha alias", which starts with the word, not under the shorter "The alpha"
      "n/zzz.md",
      "n/alpha beta.md",
    ]);
  });
});

suite("FileIndex.exclude", () => {
  it("hides the paths that a pattern matches until the patterns change", () => {
    const index = new FileIndex(vault);
    const paths = () => index.search(parseQuery("al")).map((hit) => hit.entry.file.path);

    index.exclude([/^Notes\//, /\.png$/]);
    assert.deepEqual(paths(), ["Projects/Deep/Alpha plan.md", "Archive/alpha-old.md"]);
    assert.equal(index.search([]).length, 3);

    index.exclude([]);
    assert.equal(paths().length, 7);
  });
});

suite("describe", () => {
  const view = (query: string, info: FileInfo) => {
    const terms = parseQuery(query);
    const [hit] = new FileIndex([info]).search(terms);
    assert.ok(hit, `${query} should find ${info.path}`);
    return describe(hit, terms);
  };

  it("highlights every word in the name", () => {
    assert.deepEqual(view("be al", file("Notes/Alpha Beta.md")), {
      name: [
        { text: "Al", highlighted: true },
        { text: "pha ", highlighted: false },
        { text: "Be", highlighted: true },
        { text: "ta", highlighted: false },
      ],
      extension: null,
      folder: { outer: [], inner: [{ text: "Notes", highlighted: false }] },
      aliases: [],
    });
  });

  it("shows the extension of a file that is not Markdown, without highlighting it", () => {
    assert.deepEqual(view("c.pn", file("img/pic.png")), {
      name: [
        { text: "pi", highlighted: false },
        { text: "c", highlighted: true },
      ],
      extension: "png",
      folder: { outer: [], inner: [{ text: "img", highlighted: false }] },
      aliases: [],
    });
  });

  it("shows the aliases that a word matches", () => {
    assert.deepEqual(
      view("eta", file("Notes/with-alias.md", { aliases: ["Zeta", "Other", "Eta"] })),
      {
        name: [{ text: "with-alias", highlighted: false }],
        extension: null,
        folder: { outer: [], inner: [{ text: "Notes", highlighted: false }] },
        aliases: [
          [
            { text: "Z", highlighted: false },
            { text: "eta", highlighted: true },
          ],
          [{ text: "Eta", highlighted: true }],
        ],
      },
    );
  });

  it("highlights the part after the last slash and gives the path of the folder in two parts", () => {
    const shown = view("Deep/pl -zzz", file("Projects/Deep/Alpha plan.md"));
    assert.deepEqual(shown.name, [
      { text: "Alpha ", highlighted: false },
      { text: "pl", highlighted: true },
      { text: "an", highlighted: false },
    ]);
    assert.deepEqual(shown.folder, {
      outer: [{ text: "Projects", highlighted: false }],
      inner: [
        { text: "/", highlighted: false },
        { text: "Deep", highlighted: true },
      ],
    });
    assert.deepEqual(view("x", file("A/B C/D/E/x.md")).folder, {
      outer: [{ text: "A/B C/D", highlighted: false }],
      inner: [{ text: "/E", highlighted: false }],
    });
  });

  it("highlights what a word finds in the path of the folder", () => {
    assert.deepEqual(view("soft", file("61_Software/Notes/a.md")).folder, {
      outer: [
        { text: "61_", highlighted: false },
        { text: "Soft", highlighted: true },
        { text: "ware", highlighted: false },
      ],
      inner: [{ text: "/Notes", highlighted: false }],
    });
  });

  it("highlights a word in the name and in the folder if both have it", () => {
    const shown = view("no", file("Notes/note.md"));
    assert.deepEqual(shown.name, [
      { text: "no", highlighted: true },
      { text: "te", highlighted: false },
    ]);
    assert.deepEqual(shown.folder.inner, [
      { text: "No", highlighted: true },
      { text: "tes", highlighted: false },
    ]);
  });

  it("cuts a match that reaches from the outer folders into the innermost one", () => {
    assert.deepEqual(view("ware/no", file("Software/Notes/a.md")).folder, {
      outer: [
        { text: "Soft", highlighted: false },
        { text: "ware", highlighted: true },
      ],
      inner: [
        { text: "/No", highlighted: true },
        { text: "tes", highlighted: false },
      ],
    });
  });

  it("highlights the whole word where the path has it, and not its folders apart from that", () => {
    assert.deepEqual(view("a/b", file("Data/a/b/x.md")).folder, {
      outer: [
        { text: "Data/", highlighted: false },
        { text: "a", highlighted: true },
      ],
      inner: [{ text: "/b", highlighted: true }],
    });
  });

  it("finds a word in a folder with spaces in its name", () => {
    assert.deepEqual(view("bc", file("A/B C/x.md")).folder.inner, [
      { text: "/", highlighted: false },
      { text: "B C", highlighted: true },
    ]);
  });

  it("does not highlight what a word with a minus finds, or the name part of a word with a slash", () => {
    assert.deepEqual(view("x -notes/zzz", file("Notes/x.md")).folder.inner, [
      { text: "Notes", highlighted: false },
    ]);
    assert.deepEqual(view("Plans/no", file("Plans/Dno/now.md")).folder, {
      outer: [{ text: "Plans", highlighted: true }],
      inner: [{ text: "/Dno", highlighted: false }],
    });
  });

  it("has no folder for a file in the root of the vault", () => {
    assert.deepEqual(view("root", file("root-note.md")).folder, { outer: [], inner: [] });
  });
});
