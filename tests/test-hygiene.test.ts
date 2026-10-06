import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VERSION, globToRegExp, parseDiff } from "../scripts/test-hygiene.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/test-hygiene.ts");

/** A throwaway git repo on `main` with one commit; `run` executes the checker in it. */
function repo(files: Record<string, string> = { "README.md": "x\n" }) {
	const dir = mkdtempSync(join(tmpdir(), "hygiene-"));
	const git = (...args: string[]) => {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.trim();
	};
	const write = (name: string, content: string) => {
		mkdirSync(resolve(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
	};
	const commit = (more: Record<string, string>) => {
		for (const [name, content] of Object.entries(more)) write(name, content);
		git("add", "-A");
		git("commit", "-qm", "change");
	};
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	commit(files);
	const run = (...args: string[]) => {
		const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
		return { status: r.status, stdout: r.stdout, stderr: r.stderr, hits: hits(r.stdout) };
	};
	return { dir, git, write, commit, run };
}

/** `path:line rule` pairs from the checker's output. */
function hits(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((l) => /^(\S+:\d+) {2}(\S+) {2}/.exec(l))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => `${m[1]} ${m[2]}`);
}

test("the version is on one of the first lines, before the imports", () => {
	const src = readFileSync(SCRIPT, "utf8").split("\n");
	const v = src.indexOf('export const VERSION = "5";');
	assert.ok(v >= 0 && v < 25, "VERSION line");
	assert.ok(v < src.findIndex((l) => l.startsWith("import ")));
});

test("exports a version and pure helpers", () => {
	assert.equal(VERSION, "5");
	assert.ok(globToRegExp("**/*.{test,spec}.ts").test("a/b/c.spec.ts"));
	assert.ok(globToRegExp("**/*.{test,spec}.ts").test("c.test.ts"));
	assert.ok(!globToRegExp("*.ts").test("a/c.ts"));
	assert.ok(globToRegExp("src/?.ts").test("src/a.ts"));
	assert.ok(globToRegExp("**/__tests__/**").test("x/__tests__/y/z.js"));
	assert.deepEqual(
		[...(parseDiff("+++ b/a.ts\t\n@@ -1,2 +3,2 @@\n+++ /dev/null\n+++ b/b.ts\n@@ -0,0 +5 @@\n@@ -4 +9,0 @@\n").get("a.ts") ?? [])],
		[3, 4],
	);
});

type Case = { name: string; file: string; content: string; expect: string[] };
const c = (name: string, file: string, content: string, ...expect: string[]): Case => ({ name, file, content, expect });

const RULE_CASES: Case[] = [
	// JS / TS
	c("js only", "src/a.test.ts", `it.only("x", () => {});\n`, "src/a.test.ts:1 focused"),
	c("js describe.only and fit", "src/a.spec.js", `ok();\ndescribe.only("x");\nfit("y");\n`, "src/a.spec.js:2 focused", "src/a.spec.js:3 focused"),
	c("js only outside a test file", "src/a.ts", `it.only("x");\n`),
	c("prose with mode: is not a marker", "src/a.test.ts", `it.skip("dark mode: contrast broken", () => {});\n`, "src/a.test.ts:1 skip-without-reason"),
	c("prose with mode: in a reason is not a marker", "tests/test_m.py", `@pytest.mark.skip(reason="strict mode: fails")\ndef test_m(): pass\n`, "tests/test_m.py:1 skip-without-reason"),
	c("a marker followed by a format verb", "pkg/m_test.go", `t.Skipf("platform: %s unsupported", runtime.GOOS)\n`),
	c("mocha this.skip without issue", "test/a.js", `it("x", function () {\n  this.skip();\n});\n`, "test/a.js:2 skip-without-reason"),
	c("vitest context.skip keeps its one-argument reason", "src/a.test.ts", `it("x", (context) => {\n  context.skip("platform: no symlinks on windows");\n});\n`),
	c("vitest context.skip without a marker", "src/a.test.ts", `it("x", (context) => {\n  context.skip("needs db");\n});\n`, "src/a.test.ts:2 skip-without-reason"),
	c("mocha context.skip names a suite, not a reason", "test/a.js", `context.skip("platform: suite", () => {});\n`, "test/a.js:1 skip-without-reason"),
	c("a skipped test with an issue after its name", "src/a.test.ts", `it.skip("name", () => {}); // #12\n`),
	c("mocha this.skip with issue", "test/a.js", `it("x", function () {\n  this.skip(); // #12\n});\n`),
	c("junit DisabledOnOs without issue", "src/test/java/AT.java", `@DisabledOnOs(OS.WINDOWS)\nvoid t() {}\n`, "src/test/java/AT.java:1 skip-without-reason"),
	c("junit DisabledIf with issue", "src/test/java/AT.java", `@DisabledIf("x") // PROJ-4\nvoid t() {}\n`),
	c("a standard name is not an issue key", "tests/test_a.py", `@pytest.mark.skip(reason="UTF-8 decoding broken")\ndef test_a(): pass\n`, "tests/test_a.py:1 skip-without-reason"),
	c("pytest importorskip", "tests/test_b.py", `np = pytest.importorskip("numpy")\n`, "tests/test_b.py:1 skip-without-reason"),
	c("a URL in the skipped test's body is not its issue", "e2e/a.spec.ts", `test.skip("login", async ({ page }) => {\n  await page.goto("http://localhost:3000/login");\n});\n`, "e2e/a.spec.ts:1 skip-without-reason"),
	c("code on the line above is not an issue", "src/a.test.ts", `const BASE = "https://app.test";\nit.skip("x");\n`, "src/a.test.ts:2 skip-without-reason"),
	c("a comment on the line above is", "src/a.test.ts", `// broken until #41 lands\nit.skip("x");\n`),
	c("SHA-256 is not an issue key", "src/a.test.ts", `it.skip("SHA-256 slow");\n`, "src/a.test.ts:1 skip-without-reason"),
	c("a test name is not a skip's reason", "src/a.test.ts", `it.skip("PAY-12 refund race", () => {});\n`, "src/a.test.ts:1 skip-without-reason"),
	c("a test name can't claim the platform exception", "src/a.test.ts", `describe.skip("mode: legacy", () => {});\nit.skip("handles refund #12", () => {});\n`, "src/a.test.ts:1 skip-without-reason", "src/a.test.ts:2 skip-without-reason"),
	c("a named skip with the issue in a comment", "src/a.test.ts", `it.skip("refund race", () => {}); // PAY-12\n`),
	c("mode marker (Go short mode)", "pkg/a_test.go", `if testing.Short() {\n\tt.Skip("mode: slow, runs only without -short")\n}\n`),
	c("platform marker (Python)", "tests/test_c.py", `@pytest.mark.skipif(sys.platform == "win32", reason="platform: POSIX signals only")\ndef test_c(): pass\n`),
	c("platform marker (JUnit)", "src/test/java/BT.java", `@DisabledOnOs(value = OS.WINDOWS, disabledReason = "platform: uses symlinks")\nvoid t() {}\n`),
	c("a plain reason is not a marker", "tests/test_d.py", `@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals only")\ndef test_d(): pass\n`, "tests/test_d.py:1 skip-without-reason"),
	c("a marker without a word does not count", "pkg/a_test.go", `t.Skip("platform:")\nt.Skip("mode:  ")\n`, "pkg/a_test.go:1 skip-without-reason", "pkg/a_test.go:2 skip-without-reason"),
	c("marker in a comment above", "pkg/a_test.go", `// mode: needs -race\nt.Skip()\n`),
	c("mocha marker above and trailing", "test/a.js", `// platform: no symlinks\nif (process.platform === "win32") this.skip();\nthis.skip(); // platform: no symlinks on windows\n`),
	c("skipIf is explicit now, and a plain skip after it is a violation too", "src/a.test.ts", `it.skipIf(process.platform === "win32")("unix paths", () => {});\nit.skip("broken after refactor", () => {});\n`, "src/a.test.ts:1 skip-without-reason", "src/a.test.ts:2 skip-without-reason"),
	c("playwright fixme with a URL in the condition call", "e2e/a.spec.ts", `test.fixme(({ browserName }) => browserName === "webkit", "https://github.com/o/r/issues/12");\n`),
	c("playwright skip with an issue and a function condition", "e2e/a.spec.ts", `test.skip(({ isMobile }) => isMobile, "see #12");\n`),
	c("a skip inside a one-line body", "e2e/a.spec.ts", `test("x", async () => { test.skip(true, "see #12"); });\n`),
	c("stacked pytest: the marker does not excuse the next skip", "tests/test_f.py", `@pytest.mark.skipif(sys.platform == "win32", reason="platform: posix only")\n@pytest.mark.skip(reason="not ready yet")\ndef test_f(): pass\n`, "tests/test_f.py:2 skip-without-reason"),
	c("a skip's body is dropped, a multi-line list is read", "e2e/a.spec.ts", `test.skip(\n  "login",\n  async () => {\n    await go("http://x");\n  },\n  "PROJ-7",\n);\n`),
	c("missing infrastructure is not a platform", "tests/test_e.py", `@pytest.mark.skipif(not DATABASE_URL, reason="needs a database")\ndef test_e(): pass\n`, "tests/test_e.py:1 skip-without-reason"),
	c("js skip", "src/a.test.ts", `it.skip("x", () => {});\n`, "src/a.test.ts:1 skip-without-reason"),
	c("js xit and todo", "src/a.test.ts", `xit("x");\ntest.todo("y");\n`, "src/a.test.ts:1 skip-without-reason", "src/a.test.ts:2 skip-without-reason"),
	c("js skip with issue on the line", "src/a.test.ts", `it.skip("x"); // #123\n`),
	c("js skip with issue above", "src/a.test.ts", `// see https://example.com/issues/1\nit.skip("x");\n`),
	c("js skip with ticket key", "src/a.test.ts", `// PROJ-42 flaky\nit.skip("x");\n`),
	c("js skip with allow reason", "src/a.test.ts", `it.skip("x"); // test-hygiene: allow covered by e2e suite\n`),
	c("js allow without reason", "src/a.test.ts", `it.skip("x"); // test-hygiene: allow\n`, "src/a.test.ts:1 skip-without-reason", "src/a.test.ts:1 allow-without-reason"),
	c("js promise sleep", "src/a.test.ts", `await new Promise((r) => setTimeout(r, 100));\n`, "src/a.test.ts:1 sleep"),
	c("js playwright waitForTimeout", "e2e/a.spec.ts", `await page.waitForTimeout(50);\n`, "e2e/a.spec.ts:1 sleep"),
	c("js cypress wait number vs alias", "cypress/a.cy.test.js", `cy.wait(500);\ncy.wait('@alias');\n`, "cypress/a.cy.test.js:1 sleep"),
	c("js sleep allowed", "src/a.test.ts", `await page.waitForTimeout(50); // test-hygiene: allow the debounce is the behaviour under test\n`),
	c("js setTimeout without promise is fine", "src/a.test.ts", `setTimeout(done, 1);\n`),
	// Python
	c("py skip bare", "tests/test_a.py", `@pytest.mark.skip\ndef test_a(): ...\n`, "tests/test_a.py:1 skip-without-reason"),
	c("py skip with reason=", "tests/test_a.py", `@pytest.mark.skip(reason="later")\ndef test_a(): ...\n`, "tests/test_a.py:1 skip-without-reason"),
	c("py skip with reason= and issue", "tests/test_a.py", `@pytest.mark.skip(reason="later, see #12")\ndef test_a(): ...\n`),
	c("py skipif and unittest skips", "tests/test_a.py", `@pytest.mark.skipif(sys.platform == "win32", reason="posix only")\n@unittest.skip("later")\n@unittest.skipIf(x, "y")\npytest.skip("no db")\n`, "tests/test_a.py:1 skip-without-reason", "tests/test_a.py:2 skip-without-reason", "tests/test_a.py:3 skip-without-reason", "tests/test_a.py:4 skip-without-reason"),
	c("py skipif with issue on the next line of a multi-line call", "tests/test_a.py", `@pytest.mark.skipif(\n    sys.platform == "win32",\n    reason="PROJ-5",\n)\n`),
	c("py skip with issue", "tests/test_a.py", `@pytest.mark.skip  # PROJ-12\ndef test_a(): ...\n`),
	c("py pytest.skip()", "pkg/a_test.py", `def test_a():\n    pytest.skip()\n`, "pkg/a_test.py:2 skip-without-reason"),
	c("py sleep", "tests/conftest.py", `import time\ntime.sleep(1)\n`, "tests/conftest.py:2 sleep"),
	c("py non-test file untouched", "pkg/a.py", `time.sleep(1)\n`),
	// JVM
	c("kotlin Disabled bare", "app/src/test/kotlin/AFoo.kt", `@Disabled\nfun a() {}\n`, "app/src/test/kotlin/AFoo.kt:1 skip-without-reason"),
	c("kotlin Disabled with text", "app/src/test/kotlin/AFoo.kt", `@Disabled("not supported on CI")\nfun a() {}\n`, "app/src/test/kotlin/AFoo.kt:1 skip-without-reason"),
	c("kotlin Disabled with issue", "app/src/test/kotlin/AFoo.kt", `@Disabled("flaky, see #12")\nfun a() {}\n`),
	c("java Ignore bare and sleep", "app/src/test/java/FooTest.java", `@Ignore\npublic void a() { Thread.sleep(100); }\n`, "app/src/test/java/FooTest.java:1 skip-without-reason", "app/src/test/java/FooTest.java:2 sleep"),
	c("java Ignore with string", "lib/FooTest.java", `@Ignore("slow")\n`, "lib/FooTest.java:1 skip-without-reason"),
	c("android test dir", "app/src/androidTest/kotlin/X.kt", `Thread.sleep(5)\n`, "app/src/androidTest/kotlin/X.kt:1 sleep"),
	// Go
	c("go skip bare", "pkg/a_test.go", `func TestA(t *testing.T) {\n\tt.Skip()\n}\n`, "pkg/a_test.go:2 skip-without-reason"),
	c("go skip with text", "pkg/a_test.go", `\tt.Skip("needs docker")\n`, "pkg/a_test.go:1 skip-without-reason"),
	c("go skip with issue, Skipf", "pkg/a_test.go", `\tt.Skipf("x %d", 1)\n\tt.Skip("needs docker, #44")\n`, "pkg/a_test.go:1 skip-without-reason"),
	c("go SkipNow and sleep", "pkg/a_test.go", `t.SkipNow()\ntime.Sleep(time.Second)\n`, "pkg/a_test.go:1 skip-without-reason", "pkg/a_test.go:2 sleep"),
	// Swift
	c("swift XCTSkipIf bare", "AppTests/FooTests.swift", `try XCTSkipIf(true)\n`, "AppTests/FooTests.swift:1 skip-without-reason"),
	c("swift XCTSkipIf with message", "AppTests/FooTests.swift", `try XCTSkipIf(true, "no simulator")\n`, "AppTests/FooTests.swift:1 skip-without-reason"),
	c("swift XCTSkipIf with issue and Swift Testing disabled", "AppTests/FooTests.swift", `@Test(.disabled("later"))\ntry XCTSkipIf(true, "no simulator PROJ-3")\n`, "AppTests/FooTests.swift:1 skip-without-reason"),
	c("swift sleeps", "AppTests/FooTests.swift", `sleep(1)\nusleep(10)\nThread.sleep(forTimeInterval: 1)\n`, "AppTests/FooTests.swift:1 sleep", "AppTests/FooTests.swift:2 sleep", "AppTests/FooTests.swift:3 sleep"),
	// C#
	c("cs Ignore bare", "Foo.Tests/FooTests.cs", `[Ignore]\npublic void A() {}\n`, "Foo.Tests/FooTests.cs:1 skip-without-reason"),
	c("cs Fact empty skip", "Foo.Tests/FooTests.cs", `[Fact(Skip = "")]\n`, "Foo.Tests/FooTests.cs:1 skip-without-reason"),
	c("cs Fact skip with text", "Foo.Tests/FooTests.cs", `[Fact(Skip = "slow")]\n[Test, Ignore]\n[Ignore("later")]\n[Fact(Skip = "slow, #3")]\n`, "Foo.Tests/FooTests.cs:1 skip-without-reason", "Foo.Tests/FooTests.cs:2 skip-without-reason", "Foo.Tests/FooTests.cs:3 skip-without-reason"),
	c("cs Task.Delay", "FooTests/Bar.cs", `await Task.Delay(100);\n`, "FooTests/Bar.cs:1 sleep"),
	// Gherkin
	c("gherkin only", "features/a.feature", `@only\nScenario: a\n`, "features/a.feature:1 focused"),
	c("gherkin focus", "features/a.feature", `@smoke @focus\nScenario: a\n`, "features/a.feature:1 focused"),
	c("gherkin skip tags", "features/a.feature", `@wip\nScenario: a\n@skip\nScenario: b\n`, "features/a.feature:1 skip-without-reason", "features/a.feature:3 skip-without-reason"),
	c("gherkin skip with ticket", "features/a.feature", `@wip @ABC-12\nScenario: a\n`),
];

RULE_CASES.push(
	// comments are not code
	c("comment-only lines are ignored", "src/a.test.ts", `// it.only("x")\n/* it.skip("x") */\n * waitForTimeout(5)\n`),
	c("python comment is ignored", "tests/test_a.py", `# time.sleep(1)\nx = 1  # pytest.skip()\n`),
	c("trailing comment is ignored but code before it counts", "src/a.test.ts", `ok(); // it.only("x")\nit.only("y"); // fine\n`, "src/a.test.ts:2 focused"),
	c("gherkin comment is ignored", "features/a.feature", `# @only\nScenario: a\n`),
	// the test API, not any method called skip / only
	c("skip method call is not a test skip", "src/W.test.tsx", `act(() => result.current.skip());\nresult.current.only(1);\n`),
	c("skip variants of the test API", "src/a.test.ts", `it.skip.each([1])("x", () => {});\ntest.skip("y");\nsuite.skip("z");\ndescribe.concurrent.skip("w");\n`, "src/a.test.ts:1 skip-without-reason", "src/a.test.ts:2 skip-without-reason", "src/a.test.ts:3 skip-without-reason", "src/a.test.ts:4 skip-without-reason"),
	c("only variants of the test API", "src/a.test.ts", `test.concurrent.only("x");\ndescribe.only.each([1])("y", () => {});\n`, "src/a.test.ts:1 focused", "src/a.test.ts:2 focused"),
	c("skipIf, runIf and conditional test.skip need an issue too", "src/a.test.ts", `it.skipIf(win)("x");\nit.runIf(mac)("y");\ntest.skip(browserName === "firefox", "bug");\ntest.fixme("z");\n`, "src/a.test.ts:1 skip-without-reason", "src/a.test.ts:2 skip-without-reason", "src/a.test.ts:3 skip-without-reason", "src/a.test.ts:4 skip-without-reason"),
	c("conditional skip with a ticket", "src/a.test.ts", `test.skip(browserName === "firefox", "PROJ-9 firefox bug");\n`),
	c("playwright describe modifiers", "e2e/a.spec.ts", `test.describe.only("a", () => {});\ntest.describe.serial.only("b", () => {});\ntest.describe.parallel.only("c", () => {});\ntest.describe.skip("d", () => {});\ntest.describe.fixme("e", () => {});\n`, "e2e/a.spec.ts:1 focused", "e2e/a.spec.ts:2 focused", "e2e/a.spec.ts:3 focused", "e2e/a.spec.ts:4 skip-without-reason", "e2e/a.spec.ts:5 skip-without-reason"),
	c("gherkin skip with ticket-less reason comment", "features/a.feature", `@skip # needs docker\nScenario: a\n`, "features/a.feature:1 skip-without-reason"),
	c("sleep(0) and asyncio.sleep(0) yield, not wait", "tests/test_a.py", `await asyncio.sleep(0)\ntime.sleep(0)\ntime.sleep(0.5)\n`, "tests/test_a.py:3 sleep"),
	c("timers/promises setTimeout is a sleep", "src/a.test.ts", `await setTimeout(100);\n`, "src/a.test.ts:1 sleep"),
	c("multi-line block comment is a comment", "src/a.test.ts", `/*\n it.only("x");\n page.waitForTimeout(1);\n*/\nit.only("y"); /* a */ ok();\n/* b */ it.only("z");\n`, "src/a.test.ts:5 focused", "src/a.test.ts:6 focused"),
	c("ginkgo focus", "pkg/a_test.go", `FIt("x", func() {})\nFDescribe("y", func() {})\nFContext("z", func() {})\n`, "pkg/a_test.go:1 focused", "pkg/a_test.go:2 focused", "pkg/a_test.go:3 focused"),
	c("TimeUnit sleep", "app/src/test/java/FooTest.java", `TimeUnit.SECONDS.sleep(1);\n`, "app/src/test/java/FooTest.java:1 sleep"),
	c("cypress, nest and mocha test globs", "cypress/e2e/a.cy.ts", `it.only("x");\n`, "cypress/e2e/a.cy.ts:1 focused"),
	c("nest e2e-spec glob", "app.e2e-spec.ts", `it.only("x");\n`, "app.e2e-spec.ts:1 focused"),
	c("mocha test dir glob", "test/helpers.js", `it.only("x");\n`, "test/helpers.js:1 focused"),
	c("e2e dir glob", "e2e/flow.ts", `it.only("x");\n`, "e2e/flow.ts:1 focused"),
	c("e2e suffix glob", "src/a.e2e.ts", `it.only("x");\n`, "src/a.e2e.ts:1 focused"),
	// string literals are not code
	c("js fixture string", "src/a.test.ts", `["await page.waitForTimeout(500);", 1],\n\`it.only(x)\`;\n'it.skip(y)';\n`),
	c("code after an escaped quote still counts", "src/a.test.ts", `const s = "a \\" b"; page.waitForTimeout(1);\n`, "src/a.test.ts:1 sleep"),
	c("apostrophe inside a double-quoted string", "src/a.test.ts", `it("don't", () => page.waitForTimeout(1));\n`, "src/a.test.ts:1 sleep"),
	c("python string", "tests/test_a.py", `s = "time.sleep(1)"\nt = 'pytest.skip()'\n`),
	c("go raw string", "pkg/a_test.go", "x := `time.Sleep(1)`\n"),
	c("kotlin string", "app/src/test/kotlin/AFoo.kt", `val s = "Thread.sleep(1)"\n`),
	c("swift and csharp strings", "AppTests/FooTests.swift", `let s = "sleep(1)"\n`),
	// polling is a condition wait
	c("sleep in while loop", "src/a.test.ts", `while (!ready) {\n\tawait new Promise((r) => setTimeout(r, 25));\n}\n`),
	c("sleep guarded by if", "src/a.test.ts", `if (!sawWaiter) await new Promise((resolve) => setTimeout(resolve, 25));\n`),
	c("sleep after return guard inside a loop", "src/a.test.ts", `for (;;) {\n\tif (done) return;\n\tawait new Promise((resolve) => setTimeout(resolve, 10));\n}\n`),
	c("python polling loop", "tests/test_a.py", `while not ok():\n    time.sleep(1)\n`),
	c("go polling loop", "pkg/a_test.go", `for !ready() {\n\ttime.Sleep(time.Millisecond)\n}\n`),
	c("loop too far above", "src/a.test.ts", `while (x) {\n\ta();\n\tb();\n\tc();\n\td();\n\tawait page.waitForTimeout(1);\n`, "src/a.test.ts:6 sleep"),
	c("setTimeout that rejects is a fake, not a sleep", "src/a.test.ts", `new Promise((_resolve, reject) => setTimeout(() => reject(new Error("slow")), 100));\n`),
	c("setTimeout that resolves via arrow", "src/a.test.ts", `await new Promise((resolve) => setTimeout(() => resolve(), 100));\n`, "src/a.test.ts:1 sleep"),
	c("conditional skip alias is not a skipped test", "src/a.test.ts", `const d = url ? describe : describe.skip;\nRuleTester.itOnly = it.only;\n`),
	c("shell stub and time-skipping sleeps are not fixed sleeps", "src/a.test.ts", `sleep() { printf x; }\nawait timeSkippingEnvironment.sleep("1 minute");\n`),
	c("sleep after an if guard line", "src/a.test.ts", `if (delay) {\n\tawait new Promise((resolve) => setTimeout(resolve, delay));\n}\n`),
	c("sleep after a guard return line", "src/a.test.ts", `ok();\nif (done) return;\nawait new Promise((resolve) => setTimeout(resolve, 10));\n`),
	c("plain sleep call with an argument stays a violation", "src/a.test.ts", `await sleep(31_000);\n`, "src/a.test.ts:1 sleep"),
	c("describe.skip without reference stays a violation", "src/m.test.ts", `describe.skip("migration drift", () => {});\n`, "src/m.test.ts:1 skip-without-reason"),
);

for (const k of RULE_CASES) {
	test(`rule: ${k.name}`, () => {
		const r = repo({ "README.md": "x\n", [k.file]: k.content });
		const out = r.run("--all");
		assert.deepEqual([...out.hits].sort(), [...k.expect].sort(), out.stdout);
		assert.equal(out.status, k.expect.length > 0 ? 1 : 0, out.stdout + out.stderr);
	});
}

test("ratchet: pre-existing violations do not fail PR mode but are counted", () => {
	const r = repo({ "old.test.ts": `it.only("old");\n` });
	r.git("switch", "-qc", "feat/x");
	r.commit({ "new.test.ts": `ok();\n` });
	const out = r.run();
	assert.equal(out.status, 0, out.stdout + out.stderr);
	assert.match(out.stdout, /pre-existing: 1/);
	assert.deepEqual(out.hits, []);
});

test("ratchet: a new violation fails with path:line, --all fails on both", () => {
	const r = repo({ "old.test.ts": `it.only("old");\n` });
	r.git("switch", "-qc", "feat/x");
	r.commit({ "new.test.ts": `ok();\nok();\nit.only("new");\n` });
	const pr = r.run();
	assert.equal(pr.status, 1);
	assert.deepEqual(pr.hits, ["new.test.ts:3 focused"]);
	assert.match(pr.stdout, /pre-existing: 1/);
	const all = r.run("--all");
	assert.equal(all.status, 1);
	assert.deepEqual([...all.hits].sort(), ["new.test.ts:3 focused", "old.test.ts:1 focused"]);
});

test("ratchet: only changed lines of an existing file count; --base is honoured", () => {
	const r = repo({ "a.test.ts": `it.only("old");\nok();\n` });
	r.git("switch", "-qc", "feat/x");
	r.commit({ "a.test.ts": `it.only("old");\nok();\nit.skip("new");\n` });
	assert.deepEqual(r.run().hits, ["a.test.ts:3 skip-without-reason"]);
	assert.deepEqual(r.run("--base", "main").hits, ["a.test.ts:3 skip-without-reason"]);
	assert.equal(r.run("--base", "no-such-ref").status, 2);
});

test("falls back to master when there is no main", () => {
	const r = repo({ "a.test.ts": `ok();\n` });
	r.git("branch", "-m", "main", "master");
	r.git("switch", "-qc", "feat/x");
	r.commit({ "b.test.ts": `fit("x");\n` });
	assert.deepEqual(r.run().hits, ["b.test.ts:1 focused"]);
});

const RETRY_CASES: Case[] = [
	c("playwright", "playwright.config.ts", `export default {\n\tretries: process.env.CI ? 2 : 0,\n};\n`, "playwright.config.ts:2 retries"),
	c("playwright zero is fine", "playwright.config.ts", `export default { retries: 0 };\n`),
	c("cypress", "cypress.config.js", `module.exports = { retries: { runMode: 2 } };\n`, "cypress.config.js:1 retries"),
	c("jest retryTimes", "src/setup.js", `jest.retryTimes(3);\n`, "src/setup.js:1 retries"),
	c("vitest", "vitest.config.ts", `export default { test: { retry: 2 } };\n`, "vitest.config.ts:1 retries"),
	c("pytest ini", "pytest.ini", `[pytest]\naddopts = --reruns 2\n`, "pytest.ini:2 retries"),
	c("pytest requirements", "requirements-dev.txt", `pytest-rerunfailures==14.0\n`, "requirements-dev.txt:1 retries"),
	c("gradle plugin", "app/build.gradle.kts", `plugins { id("org.gradle.test-retry") version "1.5.0" }\n`, "app/build.gradle.kts:1 retries"),
	c("gradle retry block", "build.gradle", `test {\n\tretry {\n\t\tmaxRetries = 2\n\t}\n}\n`, "build.gradle:2 retries"),
	c("gotestsum", ".github/workflows/ci.yml", `      - run: gotestsum --rerun-fails ./...\n`, ".github/workflows/ci.yml:1 retries"),
	c("xcodebuild", "ci.yaml", `- run: xcodebuild test -retry-tests-on-failure\n`, "ci.yaml:1 retries"),
	c("retries allowed with reason", "playwright.config.ts", `retries: 2, // test-hygiene: allow third-party sandbox is flaky, ticket PROJ-9\n`),
];

RETRY_CASES.push(
	c("jest.retryTimes inside a string literal is a fixture", "src/a.test.ts", `["jest.retryTimes(", 1];\n`),
	c("mocha this.retries and playwright configure", "src/a.test.ts", `this.retries(2);\ntest.describe.configure({ mode: "serial", retries: 2 });\ntest.describe.configure({ retries: 0 });\n`, "src/a.test.ts:1 retries", "src/a.test.ts:2 retries"),
	c("pytest flaky marker and reruns=", "tests/test_a.py", `@pytest.mark.flaky(reruns=3)\ndef test_a(): ...\n`, "tests/test_a.py:1 retries"),
	c("cypress zero retries object", "cypress.config.ts", `export default { retries: { runMode: 0, openMode: 0 } };\n`),
	c("cypress non-zero retries object", "cypress.config.ts", `export default { retries: { runMode: 2, openMode: 0 } };\n`, "cypress.config.ts:1 retries"),
	c("cypress multi-line retries object", "cypress.config.ts", `retries: {\n\trunMode: 0,\n\topenMode: 1,\n},\n`, "cypress.config.ts:1 retries"),
	c("cypress multi-line zero object", "cypress.config.ts", `retries: {\n\trunMode: 0,\n\topenMode: 0,\n},\nworkers: 4,\n`),
	c("flaky marker definition is not a retry", "pyproject.toml", `[tool.pytest.ini_options]\nmarkers = ["flaky: known flaky tests"]\n`),
	c("flaky dependency is a retry", "requirements-test.txt", `flaky==3.7.0\n`, "requirements-test.txt:1 retries"),
	c("comment mentioning retries", "playwright.config.ts", `// retain-on-failure, not on-first-retry: with retries: 0 (RFC-0008 §8)\n/* retries: 3 */\n * retries: 3\n`),
	c("digits after the value are not the value", "playwright.config.ts", `retries: 0, workers: 4,\n`),
	c("trailing comment digits", "playwright.config.ts", `retries: 0, // was 2\n`),
	c("ternary with non-zero first branch", "playwright.config.ts", `retries: CI ? 2 : 0,\n`, "playwright.config.ts:1 retries"),
	c("ternary with non-zero last branch", "playwright.config.ts", `retries: CI ? 0 : 2,\n`, "playwright.config.ts:1 retries"),
	c("commented rerun flags", "pytest.ini", `# addopts = --reruns 2\n`),
	c("yaml comment", "ci.yml", `# gotestsum --rerun-fails\n- run: go test ./... # no --rerun-fails here\n`),
);

for (const k of RETRY_CASES) {
	test(`retries: ${k.name}`, () => {
		const r = repo({ "README.md": "x\n", [k.file]: k.content });
		const out = r.run("--all");
		assert.deepEqual(out.hits, k.expect, out.stdout);
		assert.equal(out.status, k.expect.length > 0 ? 1 : 0);
	});
}

const suite = (tests: number, cases: string, extra = "") => `<?xml version="1.0"?>\n<testsuites>\n<testsuite name="s" tests="${tests}" failures="0" errors="0" skipped="0"${extra}>\n${cases}</testsuite>\n</testsuites>\n`;
const ok = (n: number) => Array.from({ length: n }, (_, i) => `<testcase name="t${i}" classname="C"/>\n`).join("");

test("junit: clean report passes, directory is searched recursively", () => {
	const r = repo({ "results/a/r.xml": suite(2, ok(2)) });
	assert.equal(r.run("--all", "--junit", "results/a/r.xml").status, 0);
	const dir = r.run("--all", "--junit", "results");
	assert.equal(dir.status, 0, dir.stdout);
});

test("junit: missing, empty and mismatch", () => {
	const r = repo({ "results/empty.xml": suite(0, ""), "other/bad.xml": suite(3, ok(2)) });
	const missing = r.run("--all", "--junit", "nothing-here");
	assert.equal(missing.status, 1);
	assert.ok(missing.hits.some((h) => h.endsWith(" junit-missing")), missing.stdout);
	const empty = r.run("--all", "--junit", "results");
	assert.ok(empty.hits.some((h) => h.endsWith(" junit-empty")), empty.stdout);
	const mismatch = r.run("--all", "--junit", "other");
	assert.equal(mismatch.status, 1);
	assert.ok(mismatch.hits.some((h) => h.endsWith(" junit-mismatch")), mismatch.stdout);
});

test("junit: a bare <skipped/> is fine (reasons are checked in the source)", () => {
	const r = repo({ "bare.xml": suite(2, `<testcase name="a"><skipped/></testcase>\n<testcase name="b"><skipped message=""></skipped></testcase>\n`) });
	assert.equal(r.run("--all", "--junit", "bare.xml").status, 0);
});

test("junit: nested suites are not double counted, single-quoted attributes work", () => {
	const nested = `<testsuites><testsuite name="o" tests="2"><testsuite name="i" tests="2"><testcase name="a"/><testcase name="b"/></testsuite></testsuite></testsuites>\n`;
	const quoted = `<testsuite name='s' tests='1'><testcase name='a'/></testsuite>\n`;
	const bad = `<testsuite name='s' tests='3'><testcase name='a'/></testsuite>\n`;
	const r = repo({ "n.xml": nested, "q.xml": quoted, "b.xml": bad });
	assert.equal(r.run("--all", "--junit", "n.xml").status, 0);
	assert.equal(r.run("--all", "--junit", "q.xml").status, 0);
	assert.ok(r.run("--all", "--junit", "b.xml").hits.some((h) => h.endsWith(" junit-mismatch")));
});

test("junit: --junit without --all checks only the reports, even outside a git repo", () => {
	const r = repo({ "a.test.ts": `it.only("x");\n`, "ok.xml": suite(1, ok(1)), "bad.xml": suite(2, ok(1)) });
	assert.equal(r.run("--junit", "ok.xml").status, 0);
	const bad = r.run("--junit", "bad.xml");
	assert.equal(bad.status, 1);
	assert.deepEqual(bad.hits.map((h) => h.split(" ")[1]), ["junit-mismatch"]);
	assert.match(bad.stdout, /test-hygiene: 1 violation\b(?!.*pre-existing)/);
	const dir = mkdtempSync(join(tmpdir(), "hygiene-nogit-"));
	writeFileSync(join(dir, "r.xml"), suite(1, ok(1)));
	const out = spawnSync(process.execPath, [SCRIPT, "--junit", "r.xml"], { cwd: dir, encoding: "utf8" });
	assert.equal(out.status, 0, out.stdout + out.stderr);
	assert.equal(r.run("--all", "--junit", "ok.xml").status, 1);
});

test("junit: only testsuites totals are used when there are no suites", () => {
	const r = repo({ "t.xml": `<testsuites tests="2"><testcase name="a"/><testcase name="b"/></testsuites>\n` });
	assert.equal(r.run("--all", "--junit", "t.xml").status, 0);
	const r2 = repo({ "t.xml": `<testsuites tests="3"><testcase name="a"/></testsuites>\n` });
	assert.ok(r2.run("--all", "--junit", "t.xml").hits.some((h) => h.endsWith(" junit-mismatch")));
});

test("ratchet: a renamed file is not all-new", () => {
	const r = repo({ "old.test.ts": `it.only("old");\nok();\n` });
	r.git("switch", "-qc", "feat/x");
	r.git("mv", "old.test.ts", "moved.test.ts");
	r.git("commit", "-qm", "move");
	const out = r.run();
	assert.equal(out.status, 0, out.stdout);
	assert.match(out.stdout, /pre-existing: 1/);
});

test("parseDiff: '\\ No newline at end of file' does not eat the hunk", () => {
	const d = "+++ b/a.ts\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n@@ -5,0 +6 @@\n+c\n";
	assert.deepEqual([...(parseDiff(d).get("a.ts") ?? [])], [1, 6]);
});

test("a shallow clone without a merge base exits 2 with a hint", () => {
	const remote = repo({ "a.txt": "1\n" });
	remote.git("switch", "-qc", "feat");
	remote.commit({ "b.txt": "2\n" });
	remote.git("switch", "-q", "main");
	remote.commit({ "c.txt": "3\n" });
	remote.git("switch", "-q", "feat");
	const clone = mkdtempSync(join(tmpdir(), "hygiene-shallow-"));
	const sh = (cwd: string, ...args: string[]) => assert.equal(spawnSync("git", args, { cwd, encoding: "utf8" }).status, 0, args.join(" "));
	sh(tmpdir(), "clone", "-q", "--depth", "1", "--branch", "feat", `file://${remote.dir}`, clone);
	sh(clone, "fetch", "-q", "--depth", "1", "origin", "main:refs/remotes/origin/main");
	const r = spawnSync(process.execPath, [SCRIPT, "--base", "origin/main"], { cwd: clone, encoding: "utf8" });
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stderr, /no merge base with origin\/main.*fetch-depth: 0/);
});

test("config: extra patterns, extra test files and ignore", () => {
	const config = JSON.stringify({
		testFiles: ["checks/**/*.sh"],
		ignore: ["vendor/**"],
		patterns: [{ id: "no-console", files: "**/*.test.ts", regex: "console\\.log\\(", message: "no console.log in tests" }],
	});
	const r = repo({
		".ci/test-hygiene.json": config,
		"a.test.ts": `console.log("x");\n`,
		"vendor/b.test.ts": `it.only("v");\nconsole.log("x");\n`,
		"checks/run.sh": `echo hi\n`,
	});
	const out = r.run("--all");
	assert.deepEqual(out.hits, ["a.test.ts:1 no-console"]);
	assert.match(out.stdout, /no console\.log in tests/);
	// testFiles extends the defaults: a .sh file is now a test file, but the rules above are JS/Python/... only
	assert.equal(out.status, 1);
});

test("config: --config path, and .ci/test-hygiene.json next to the script", () => {
	const pattern = { patterns: [{ id: "todo", files: "**/*.md", regex: "TODO", message: "no todo" }] };
	const viaPi = repo({ ".ci/test-hygiene.json": JSON.stringify(pattern), "n.md": "TODO\n" });
	assert.deepEqual(viaPi.run("--all").hits, ["n.md:1 todo"]);
	const explicit = repo({ "custom.json": JSON.stringify(pattern), "n.md": "TODO\n" });
	assert.deepEqual(explicit.run("--all", "--config", "custom.json").hits, ["n.md:1 todo"]);
	assert.equal(explicit.run("--all").status, 0);
});

test("config: invalid regex and invalid JSON exit 2 with the reason", () => {
	const bad = repo({ ".ci/test-hygiene.json": JSON.stringify({ patterns: [{ id: "x", files: "**", regex: "(", message: "m" }] }) });
	const a = bad.run("--all");
	assert.equal(a.status, 2);
	assert.match(a.stderr, /regex/i);
	const json = repo({ ".ci/test-hygiene.json": "{nope" });
	const b = json.run("--all");
	assert.equal(b.status, 2);
	assert.match(b.stderr, /test-hygiene\.json/);
	assert.equal(repo().run("--all", "--config", "missing.json").status, 2);
});

test("cli: usage and git errors exit 2", () => {
	assert.equal(repo().run("--nope").status, 2);
	const dir = mkdtempSync(join(tmpdir(), "hygiene-nogit-"));
	const r = spawnSync(process.execPath, [SCRIPT, "--all"], { cwd: dir, encoding: "utf8" });
	assert.equal(r.status, 2);
	assert.ok(r.stderr.length > 0);
});

test("cli: runs from a subdirectory and prints a summary line", () => {
	const r = repo({ "sub/a.test.ts": `it.only("x");\n` });
	const out = spawnSync(process.execPath, [SCRIPT, "--all"], { cwd: join(r.dir, "sub"), encoding: "utf8" });
	assert.equal(out.status, 1);
	assert.match(out.stdout, /^sub\/a\.test\.ts:1 {2}focused {2}/m);
	assert.match(out.stdout, /test-hygiene: 1 violation/);
	assert.match(repo().run("--all").stdout, /test-hygiene: 0 violation/);
});
