// node --test: the read-only check and command rules (command-rules.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isReadOnly, autoApproval } from "../command-rules.mjs";

const ro = (cmd, local) => isReadOnly(cmd, "me", "/workspaces", local);

test("plain reads in its own folder run without asking", () => {
  for (const c of ["ls -la", "cat notes.txt", "grep -rn foo .", "wc -l *.txt", "cat /workspaces/me/a.txt", "sort -u a.txt",
    'grep "a b" x.txt', String.raw`grep "a\"b" x.txt`, "head -n 5 a | sort | uniq -c", "find . -name '*.md'"]) {
    assert.equal(ro(c), true, c);
  }
});

test("paths out of its folder ask", () => {
  for (const c of ["cat ../other/secret", "cat /workspaces/other/secret", "cat ~/x", "cat /etc/passwd", "cat /tmp/x",
    "ls .?/", "cat /w*/other/x", "grep --file=../x .", "grep -f../x ."]) {
    assert.equal(ro(c), false, c);
  }
});

test("a backslash in double quotes is read the way sh reads it", () => {
  // sh: one word `" x`, then /workspaces/other/secret. The check used to see one word "\" and "x /workspaces/...".
  assert.equal(ro(String.raw`cat "\" x" /workspaces/other/secret`), false);
  assert.equal(ro(String.raw`cat "\" x" ../other/secret`), false);
  assert.equal(ro(String.raw`cat "\\" ../x`), false);
});

test("an option hidden in a group of one-letter options asks", () => {
  for (const c of ["sort -uo out.txt in.txt", "sort -o out.txt in.txt", "sort --output=out.txt in.txt", "tree -fo out.txt",
    "date -us 2020-01-01", "hostname -sF name.txt", "hostname -bs", "md5sum -c sums.txt", "sha256sum --check sums.txt"]) {
    assert.equal(ro(c), false, c);
  }
  assert.equal(ro("hostname -s"), true);
});

test("commands that open files named elsewhere, or follow symlinks inside folders, ask", () => {
  for (const c of ["sort --files0-from=list", "wc --files0-from=list", "du --files0-from=list", "find -files0-from list",
    "grep -R foo .", "grep -Rn foo .", "rg -L foo", "rg --follow foo", "find -L .", "find . -follow", "tree -l",
    "diff -r a b", "ls -RL", "ls -R -L", "du -L ."]) {
    assert.equal(ro(c), false, c);
  }
});

test("symlinks out of its folder ask, once the folder is on disk", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rules-")));
  const me = path.join(root, "me"), other = path.join(root, "other");
  mkdirSync(path.join(me, "sub"), { recursive: true }); mkdirSync(other);
  writeFileSync(path.join(other, "secret"), "x"); writeFileSync(path.join(me, "a.txt"), "a");
  symlinkSync(other, path.join(me, "out"));
  symlinkSync("../a.txt", path.join(me, "sub", "in"));
  symlinkSync("/workspaces/me/a.txt", path.join(me, "abs-in"));
  symlinkSync("sub", path.join(me, "dir-in"));
  assert.equal(ro("cat a.txt", me), true);
  assert.equal(ro("cat sub/in", me), true, "a link that stays inside is fine");
  assert.equal(ro("cat abs-in", me), true, "an absolute link into its own folder, as the sandbox names it");
  assert.equal(ro("cat dir-in/in", me), true, "links through links that stay inside");
  assert.equal(ro("cat sub/../a.txt", me), false, ".. in a word still asks");
  assert.equal(ro("cat new-file", me), true, "a file that doesn't exist yet is judged by its folder");
  assert.equal(ro("cat out/secret", me), false);
  assert.equal(ro("ls out", me), false);
  assert.equal(ro("cat /workspaces/me/out/secret", me), false);
  assert.equal(ro("cat *", me), false, "a glob that can match the link");
  assert.equal(ro("cat out/secret"), true, "without the folder only the text is checked");
});

test("links whose target exists only in the sandbox ask too (broken links here)", () => {
  const me = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), "rules-"))), "me");
  mkdirSync(path.join(me, "sub"), { recursive: true });
  // Broken in this container (there is no /workspaces here), another agent's file in the sandbox.
  symlinkSync("/workspaces/bob/secret", path.join(me, "x"));
  symlinkSync("/workspaces/bob", path.join(me, "bobdir"));
  symlinkSync("/tmp/shared", path.join(me, "t"));
  symlinkSync("../../bob/secret", path.join(me, "sub", "up"));
  symlinkSync("x", path.join(me, "chain"));
  symlinkSync("loop", path.join(me, "loop"));
  symlinkSync("/workspaces/me-not/secret", path.join(me, "prefix"));
  for (const c of ["cat x", "cat bobdir/secret", "ls bobdir", "cat t", "cat sub/up", "cat chain", "cat loop", "cat prefix",
    "cat /workspaces/me/x", "grep -n foo x", "wc -l *"]) {
    assert.equal(ro(c, me), false, c);
  }
  assert.equal(ro("cat sub", me), true);
  assert.equal(ro("cat sub/new/deeper.txt", me), true, "a path that doesn't exist yet");
});

test("exact and prefix rules", () => {
  const rules = [{ id: 1, kind: "prefix", pattern: "git status", lan: "none" }, { id: 2, kind: "exact", pattern: "df -h", lan: "none" }];
  assert.deepEqual(autoApproval(rules, "git status -s"), { rules: [1], lan: "none" });
  assert.equal(autoApproval(rules, "git status; rm -rf ."), null);
  assert.equal(autoApproval(rules, "git status 'x'"), null);
  assert.equal(autoApproval(rules, "git statusx"), null);
  assert.deepEqual(autoApproval(rules, "df -h"), { rules: [2], lan: "none" });
  assert.equal(autoApproval(rules, "df -h /"), null);
});

// ----- reads on a granted device (lan-ssh, lan curl) -----
import { readOnlyApproval } from "../command-rules.mjs";
const roa = (cmd) => readOnlyApproval(cmd, "me", "/workspaces", null);

test("read-only commands on a device run without asking, with the LAN access they need", () => {
  for (const c of ["lan-ssh pi df -h", "lan-ssh pi cat /etc/os-release", "lan-ssh -l admin --login PI_LOGIN pi uptime",
    "lan-ssh pi systemctl status nginx", "lan-ssh pi journalctl -u nginx -n 50 --no-pager", "lan-ssh nas docker ps -a",
    "lan-ssh nas docker logs --tail 100 web", "lan-ssh pi ip -br addr", "lan-ssh router nvram get productid",
    "lan-ssh pi ls -la /var/log", "lan-ssh pi cat /var/log/syslog | grep error | wc -l", "lan-ssh 192.168.1.60 free -m"]) {
    assert.deepEqual(roa(c), { lan: "full" }, c);
  }
  for (const c of ["lan curl -s http://192.168.1.50:8123/api/states", "lan curl -sS -H 'Accept: application/json' http://10.0.0.5/x | jq .",
    "lan curl -s 'http://192.168.1.50:8123/api/history?a=1&b=2'", "lan curl -I http://192.168.1.50/"]) {
    assert.deepEqual(roa(c), { lan: "read" }, c);
  }
  assert.deepEqual(roa("ls -la"), { lan: "none" });
});

test("changes, sudo, private data and tricks on a device still ask", () => {
  for (const c of ["lan-ssh pi rm -rf /tmp/x", "lan-ssh pi systemctl restart nginx", "lan-ssh --sudo PI pi cat /var/log/auth.log",
    "lan-ssh pi sudo cat /etc/hostname", "lan-ssh pi cat /etc/shadow", "lan-ssh pi cat /home/pi/.ssh/id_rsa", "lan-ssh pi cat app/.env",
    "lan-ssh pi cat /proc/1/environ", "lan-ssh router nvram get wl0_wpa_psk", "lan-ssh router nvram show", "lan-ssh pi printenv",
    "lan-ssh pi grep -r password /etc", "lan-ssh pi cat 'x; reboot'", "lan-ssh pi cat x\;reboot", "lan-ssh pi ls *.log",
    "lan-ssh pi ls ~", "lan-ssh pi docker rm web", "lan-ssh pi docker inspect web", "lan-ssh pi ip link set eth0 down",
    "lan-ssh pi dmesg -c", "lan-ssh pi ss -K dst 1.2.3.4", "lan-ssh pi journalctl --vacuum-size=1M", "lan-ssh pi find / -delete",
    "lan-ssh pi mount /dev/sda1 /mnt", "lan-ssh pi top", "lan-ssh pi sh -c ls", "lan-ssh pi", "lan-ssh pi cat ~/notes"]) {
    assert.equal(roa(c), null, c);
  }
  for (const c of ["lan curl -s -o out http://192.168.1.50/", "lan curl -X POST http://192.168.1.50/", "lan curl -d a=1 http://192.168.1.50/",
    "lan curl -s https://example.com/", "lan curl -s http://192.168.1.50/ -w '%output{x}'", "lan curl -K cfg http://192.168.1.50/",
    "lan curl --noproxy '*' http://192.168.1.50/", "lan curl -H @hdrs http://192.168.1.50/", "curl -s http://192.168.1.50/",
    "lan curl -s http://8.8.8.8/", "lan wget http://192.168.1.50/", "lan curl -s http://192.168.1.50/ > x"]) {
    assert.equal(roa(c), null, c);
  }
});

test("isReadOnly stays about the agent's own folder", () => {
  assert.equal(isReadOnly("lan-ssh pi df -h", "me"), false);
  assert.equal(isReadOnly("cat notes.txt", "me"), true);
});
