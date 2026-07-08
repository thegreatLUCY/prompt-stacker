/* Unit tests for the pure (DOM-free) helpers in content.js.
   Run: node test/parse.test.cjs */
const assert = require("assert");
const { parsePrompts, extractVars, applyVars, serializeQueue } = require("../content.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ✓ " + name);
}

console.log("parsePrompts");
test("splits on blank lines", () => {
  assert.deepStrictEqual(parsePrompts("a\n\nb\n\nc"), ["a", "b", "c"]);
});
test("splits on --- divider", () => {
  assert.deepStrictEqual(parsePrompts("a\n---\nb"), ["a", "b"]);
});
test("keeps multi-line prompts intact", () => {
  assert.deepStrictEqual(parsePrompts("line 1\nline 2\n\nnext"), ["line 1\nline 2", "next"]);
});
test("trims and drops empties", () => {
  assert.deepStrictEqual(parsePrompts("  a  \n\n\n\n  b  "), ["a", "b"]);
});
test("empty input yields empty array", () => {
  assert.deepStrictEqual(parsePrompts("   \n\n  "), []);
});

console.log("extractVars");
test("finds unique vars in first-seen order", () => {
  assert.deepStrictEqual(extractVars(["Hi {{name}}", "{{topic}} and {{name}}"]), ["name", "topic"]);
});
test("handles whitespace in braces", () => {
  assert.deepStrictEqual(extractVars(["{{  city  }}"]), ["city"]);
});
test("no vars → empty", () => {
  assert.deepStrictEqual(extractVars(["plain text"]), []);
});

console.log("applyVars");
test("substitutes known vars", () => {
  assert.strictEqual(applyVars("Hi {{name}}", { name: "Ada" }), "Hi Ada");
});
test("leaves unknown vars untouched", () => {
  assert.strictEqual(applyVars("{{a}} {{b}}", { a: "x" }), "x {{b}}");
});
test("substitutes repeated occurrences", () => {
  assert.strictEqual(applyVars("{{x}}-{{x}}", { x: "9" }), "9-9");
});

console.log("serializeQueue / round-trip");
test("serialize + parse round-trips", () => {
  const q = ["first\nmulti", "second", "third"];
  assert.deepStrictEqual(parsePrompts(serializeQueue(q)), q);
});

console.log(`\n${passed} tests passed.`);
