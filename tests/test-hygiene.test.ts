import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("exports a version and pure helpers", () => {
	assert.equal(VERSION, "1");
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
	c("py skip with reason=", "tests/test_a.py", `@pytest.mark.skip(reason="later")\ndef test_a(): ...\n`),
	c("py skip with issue", "tests/test_a.py", `@pytest.mark.skip  # PROJ-12\ndef test_a(): ...\n`),
	c("py pytest.skip()", "pkg/a_test.py", `def test_a():\n    pytest.skip()\n`, "pkg/a_test.py:2 skip-without-reason"),
	c("py sleep", "tests/conftest.py", `import time\ntime.sleep(1)\n`, "tests/conftest.py:2 sleep"),
	c("py non-test file untouched", "pkg/a.py", `time.sleep(1)\n`),
	// JVM
	c("kotlin Disabled bare", "app/src/test/kotlin/AFoo.kt", `@Disabled\nfun a() {}\n`, "app/src/test/kotlin/AFoo.kt:1 skip-without-reason"),
	c("kotlin Disabled with text", "app/src/test/kotlin/AFoo.kt", `@Disabled("not supported on CI")\nfun a() {}\n`),
	c("kotlin Disabled with issue", "app/src/test/kotlin/AFoo.kt", `@Disabled("flaky, see #12")\nfun a() {}\n`),
	c("java Ignore bare and sleep", "app/src/test/java/FooTest.java", `@Ignore\npublic void a() { Thread.sleep(100); }\n`, "app/src/test/java/FooTest.java:1 skip-without-reason", "app/src/test/java/FooTest.java:2 sleep"),
	c("java Ignore with string", "lib/FooTest.java", `@Ignore("slow")\n`),
	c("android test dir", "app/src/androidTest/kotlin/X.kt", `Thread.sleep(5)\n`, "app/src/androidTest/kotlin/X.kt:1 sleep"),
	// Go
	c("go skip bare", "pkg/a_test.go", `func TestA(t *testing.T) {\n\tt.Skip()\n}\n`, "pkg/a_test.go:2 skip-without-reason"),
	c("go skip with text", "pkg/a_test.go", `\tt.Skip("needs docker")\n`),
	c("go SkipNow and sleep", "pkg/a_test.go", `t.SkipNow()\ntime.Sleep(time.Second)\n`, "pkg/a_test.go:1 skip-without-reason", "pkg/a_test.go:2 sleep"),
	// Swift
	c("swift XCTSkipIf bare", "AppTests/FooTests.swift", `try XCTSkipIf(true)\n`, "AppTests/FooTests.swift:1 skip-without-reason"),
	c("swift XCTSkipIf with message", "AppTests/FooTests.swift", `try XCTSkipIf(true, "no simulator")\n`),
	c("swift sleeps", "AppTests/FooTests.swift", `sleep(1)\nusleep(10)\nThread.sleep(forTimeInterval: 1)\n`, "AppTests/FooTests.swift:1 sleep", "AppTests/FooTests.swift:2 sleep", "AppTests/FooTests.swift:3 sleep"),
	// C#
	c("cs Ignore bare", "Foo.Tests/FooTests.cs", `[Ignore]\npublic void A() {}\n`, "Foo.Tests/FooTests.cs:1 skip-without-reason"),
	c("cs Fact empty skip", "Foo.Tests/FooTests.cs", `[Fact(Skip = "")]\n`, "Foo.Tests/FooTests.cs:1 skip-without-reason"),
	c("cs Fact skip with text", "Foo.Tests/FooTests.cs", `[Fact(Skip = "slow")]\n`),
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
	c("skipIf is a conditional skip, not flagged", "src/a.test.ts", `it.skipIf(win)("x");\n`),
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

test("junit: skipped without reason fails, with message or text passes", () => {
	const bad = `<testcase name="a"><skipped/></testcase>\n<testcase name="b"><skipped message=""></skipped></testcase>\n`;
	const good = `<testcase name="a"><skipped message="needs docker"/></testcase>\n<testcase name="b"><skipped>flaky, PROJ-1</skipped></testcase>\n`;
	const r = repo({ "bad.xml": suite(2, bad), "good.xml": suite(2, good) });
	const b = r.run("--all", "--junit", "bad.xml");
	assert.equal(b.status, 1);
	assert.deepEqual(b.hits.map((h) => h.split(" ")[1]), ["junit-skip-without-reason", "junit-skip-without-reason"]);
	assert.equal(r.run("--all", "--junit", "good.xml").status, 0);
});

test("junit: only testsuites totals are used when there are no suites", () => {
	const r = repo({ "t.xml": `<testsuites tests="2"><testcase name="a"/><testcase name="b"/></testsuites>\n` });
	assert.equal(r.run("--all", "--junit", "t.xml").status, 0);
	const r2 = repo({ "t.xml": `<testsuites tests="3"><testcase name="a"/></testsuites>\n` });
	assert.ok(r2.run("--all", "--junit", "t.xml").hits.some((h) => h.endsWith(" junit-mismatch")));
});

const TASK = `# Task\n\n## Success criteria\n\n| # | Criterion | How verified |\n|---|-----------|--------------|\n| 1 | User logs in | scenario |\n| 2 | Cache is fast | benchmark |\n| 3 | User logs out | @C3 |\n`;

test("criteria: clean mapping passes", () => {
	const r = repo({ "docs/tasks/2026-01-01-a.md": TASK, "features/a.feature": `Feature: auth\n\n@C1\nScenario: login\n\n@C3 @smoke\nScenario: logout\n` });
	const out = r.run("--all");
	assert.equal(out.status, 0, out.stdout);
});

test("criteria: scenario-verified criterion without a tagged scenario", () => {
	const r = repo({ "docs/tasks/2026-01-01-a.md": TASK, "features/a.feature": `Feature: auth\n\n@C1\nScenario: login\n` });
	const out = r.run("--all");
	assert.equal(out.status, 1);
	assert.deepEqual(out.hits, ["docs/tasks/2026-01-01-a.md:9 criterion-without-scenario"]);
});

test("criteria: two scenarios for one criterion", () => {
	const r = repo({ "docs/tasks/2026-01-01-a.md": TASK, "features/a.feature": `Feature: auth\n@C1\nScenario: a\n@C1\nScenario Outline: b\n@C3\nScenario: c\n` });
	const out = r.run("--all");
	assert.equal(out.status, 1);
	assert.ok(out.hits.some((h) => h.endsWith(" criterion-many-scenarios")), out.stdout);
	assert.equal(out.hits.length, 1);
});

test("criteria: tag without a criterion", () => {
	const r = repo({ "docs/tasks/2026-01-01-a.md": TASK, "features/a.feature": `Feature: auth\n@C1\nScenario: a\n@C3\nScenario: c\n@C9\nScenario: z\n` });
	const out = r.run("--all");
	assert.deepEqual(out.hits, ["features/a.feature:6 tag-without-criterion"]);
});

test("criteria: not checked without feature files or without task files", () => {
	assert.equal(repo({ "docs/tasks/2026-01-01-a.md": TASK }).run("--all").status, 0);
	assert.equal(repo({ "features/a.feature": `@C9\nScenario: z\n` }).run("--all").status, 0);
});

test("criteria: not ratcheted, also reported in PR mode", () => {
	const r = repo({ "docs/tasks/2026-01-01-a.md": TASK, "features/a.feature": `@C1\nScenario: a\n` });
	r.git("switch", "-qc", "feat/x");
	r.commit({ "README.md": "y\n" });
	assert.equal(r.run().status, 1);
});

test("config: extra patterns, extra test files and ignore", () => {
	const config = JSON.stringify({
		testFiles: ["checks/**/*.sh"],
		ignore: ["vendor/**"],
		patterns: [{ id: "no-console", files: "**/*.test.ts", regex: "console\\.log\\(", message: "no console.log in tests" }],
	});
	const r = repo({
		".claude/test-hygiene.json": config,
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

test("config: --config path, and .pi/test-hygiene.json as fallback", () => {
	const pattern = { patterns: [{ id: "todo", files: "**/*.md", regex: "TODO", message: "no todo" }] };
	const viaPi = repo({ ".pi/test-hygiene.json": JSON.stringify(pattern), "n.md": "TODO\n" });
	assert.deepEqual(viaPi.run("--all").hits, ["n.md:1 todo"]);
	const explicit = repo({ "custom.json": JSON.stringify(pattern), "n.md": "TODO\n" });
	assert.deepEqual(explicit.run("--all", "--config", "custom.json").hits, ["n.md:1 todo"]);
	assert.equal(explicit.run("--all").status, 0);
});

test("config: invalid regex and invalid JSON exit 2 with the reason", () => {
	const bad = repo({ ".claude/test-hygiene.json": JSON.stringify({ patterns: [{ id: "x", files: "**", regex: "(", message: "m" }] }) });
	const a = bad.run("--all");
	assert.equal(a.status, 2);
	assert.match(a.stderr, /regex/i);
	const json = repo({ ".claude/test-hygiene.json": "{nope" });
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
