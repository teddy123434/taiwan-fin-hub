import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WORKFLOW_PREFIX = ".github/workflows/";
const WORKFLOW_PATHSPEC = ".github/workflows";
const DEFAULT_UPSTREAM_URL = "https://github.com/TedLin1993/all-set-tw.git";
const UPSTREAM_TRAILER = "Taiwan-Fin-Hub-Upstream";

class SyncError extends Error {}

function runGit(args, options = {}) {
  const {
    allowedExitCodes = [0],
    environment = {},
    output = "text",
    input,
  } = options;
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    input,
    encoding: output === "buffer" ? undefined : "utf8",
    env: { ...process.env, ...environment },
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new SyncError(
      `無法執行 git ${args.join(" ")}：${result.error.message}`,
    );
  }

  if (!allowedExitCodes.includes(result.status)) {
    const stdout = result.stdout?.toString().trim();
    const stderr = result.stderr?.toString().trim();
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new SyncError(
      `git ${args.join(" ")} 執行失敗（exit ${result.status}）${
        details ? `：\n${details}` : ""
      }`,
    );
  }

  return result;
}

function gitText(args, options) {
  return runGit(args, options).stdout.trim();
}

function assertCleanWorkingTree() {
  const status = gitText(["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    throw new SyncError(
      "工作目錄含有尚未提交的變更，為避免覆蓋內容，本次同步已停止。",
    );
  }
}

function treeFingerprint(commit) {
  const tree = runGit(["ls-tree", "-r", "-z", "--full-tree", commit], {
    output: "buffer",
  }).stdout;
  const hash = createHash("sha256");

  for (const entry of tree.subarray(0, -1).toString("utf8").split("\0")) {
    const separator = entry.indexOf("\t");
    const path = separator === -1 ? "" : entry.slice(separator + 1);
    if (!path.startsWith(WORKFLOW_PREFIX)) {
      hash.update(entry);
      hash.update("\0");
    }
  }

  return hash.digest("hex");
}

function findMatchingUpstreamCommit(rootCommit, upstreamRef) {
  const expectedFingerprint = treeFingerprint(rootCommit);
  const upstreamCommits = gitText(["rev-list", upstreamRef])
    .split("\n")
    .filter(Boolean);

  for (const commit of upstreamCommits) {
    if (treeFingerprint(commit) === expectedFingerprint) {
      return commit;
    }
  }

  return undefined;
}

function changedPathsOutsideWorkflows(rootCommit) {
  const output = runGit(
    ["diff", "--no-renames", "--name-only", "-z", rootCommit, "HEAD"],
    { output: "buffer" },
  ).stdout;

  return output
    .subarray(0, -1)
    .toString("utf8")
    .split("\0")
    .filter((path) => path && !path.startsWith(WORKFLOW_PREFIX));
}

function mergeBase(left, right) {
  const result = runGit(["merge-base", left, right], {
    allowedExitCodes: [0, 1],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function isAncestor(ancestor, descendant) {
  const result = runGit(["merge-base", "--is-ancestor", ancestor, descendant], {
    allowedExitCodes: [0, 1],
  });
  return result.status === 0;
}

function ensureBackupBranch(originRemote, backupBranch) {
  const remoteRef = `refs/heads/${backupBranch}`;
  const result = runGit(
    ["ls-remote", "--exit-code", "--heads", originRemote, remoteRef],
    { allowedExitCodes: [0, 2] },
  );

  if (result.status === 0) {
    console.log(
      `備份 branch ${backupBranch} 已存在；為避免覆寫既有備份，將直接沿用。`,
    );
    return;
  }

  console.log(`建立首次同步備份 branch：${backupBranch}`);
  runGit(["push", originRemote, `HEAD:${remoteRef}`]);
}

function findRecordedUpstreamCommit(upstreamRef) {
  const matchingTargetCommits = gitText([
    "log",
    "--format=%H",
    "--grep",
    `${UPSTREAM_TRAILER}:`,
    "HEAD",
  ])
    .split("\n")
    .filter(Boolean);

  for (const targetCommit of matchingTargetCommits) {
    const message = gitText(["show", "-s", "--format=%B", targetCommit]);
    const matches = [
      ...message.matchAll(
        new RegExp(`^${UPSTREAM_TRAILER}: ([0-9a-f]{40,64})$`, "gm"),
      ),
    ];
    const upstreamCommit = matches.at(-1)?.[1];
    if (!upstreamCommit) {
      continue;
    }

    const objectCheck = runGit(
      ["cat-file", "-e", `${upstreamCommit}^{commit}`],
      { allowedExitCodes: [0, 128] },
    );
    if (objectCheck.status !== 0 || !isAncestor(upstreamCommit, upstreamRef)) {
      throw new SyncError(
        `先前同步紀錄的上游 commit ${upstreamCommit} 已不在目前上游歷史中，無法安全判定三方合併基準。`,
      );
    }

    return upstreamCommit;
  }

  return undefined;
}

function parseTreeEntries(commit, pathspec) {
  const output = runGit(
    ["ls-tree", "-r", "-z", "--full-tree", commit, "--", pathspec],
    { output: "buffer" },
  ).stdout;
  if (output.length === 0) {
    return [];
  }

  return output
    .subarray(0, -1)
    .toString("utf8")
    .split("\0")
    .map((entry) => {
      const match = /^(\d+) \w+ ([0-9a-f]+)\t(.+)$/.exec(entry);
      if (!match) {
        throw new SyncError(`無法解析 Git tree entry：${entry}`);
      }
      return { mode: match[1], object: match[2], path: match[3] };
    });
}

// Only the top-level Worker name is deployment identity. All other settings
// still participate in the normal three-way merge and conflict checks.
function customizedWorkerConfig(sourceCommit, baseline) {
  const read = (commit) => {
    const result = runGit(["show", `${commit}:wrangler.toml`], {
      allowedExitCodes: [0, 128],
    });
    return result.status === 0 ? result.stdout : undefined;
  };
  const nameLine = (text) => {
    if (text === undefined) return undefined;
    const topLevel = text.split(/^\s*\[/m, 1)[0];
    const matches = [
      ...topLevel.matchAll(
        /^name\s*=\s*("[^"\n]+"|'[^'\n]+')[ \t]*(?:#[^\n]*)?$/gm,
      ),
    ];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const original = nameLine(read(baseline));
  const installed = nameLine(read("HEAD"));
  const source = read(sourceCommit);
  const incoming = nameLine(source);
  if (!original || !installed || !incoming || original[1] === installed[1]) {
    return undefined;
  }
  return (
    source.slice(0, incoming.index) +
    incoming[0].replace(incoming[1], installed[1]) +
    source.slice(incoming.index + incoming[0].length)
  );
}

function treeWithWorkflowsFrom(sourceCommit, workflowSourceCommit, baseline) {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "taiwan-fin-hub-sync-index-"),
  );
  const temporaryIndex = path.join(temporaryDirectory, "index");
  const environment = { GIT_INDEX_FILE: temporaryIndex };

  try {
    runGit(["read-tree", sourceCommit], { environment });
    for (const entry of parseTreeEntries(sourceCommit, WORKFLOW_PATHSPEC)) {
      runGit(["update-index", "--force-remove", "--", entry.path], {
        environment,
      });
    }
    for (const entry of parseTreeEntries(
      workflowSourceCommit,
      WORKFLOW_PATHSPEC,
    )) {
      runGit(
        [
          "update-index",
          "--add",
          "--cacheinfo",
          entry.mode,
          entry.object,
          entry.path,
        ],
        { environment },
      );
    }
    if (baseline) {
      const config = customizedWorkerConfig(sourceCommit, baseline);
      if (config !== undefined) {
        const object = gitText(["hash-object", "-w", "--stdin"], {
          input: config,
        });
        const entry = parseTreeEntries(sourceCommit, "wrangler.toml")[0];
        runGit(
          [
            "update-index",
            "--add",
            "--cacheinfo",
            entry.mode,
            object,
            entry.path,
          ],
          { environment },
        );
      }
    }
    return gitText(["write-tree"], { environment });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function temporaryCommitForTree(tree) {
  return gitText(["commit-tree", tree, "-m", "temporary sync merge tree"], {
    environment: {
      GIT_AUTHOR_NAME: "taiwan-fin-hub-updater",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "taiwan-fin-hub-updater",
      GIT_COMMITTER_EMAIL:
        "41898282+github-actions[bot]@users.noreply.github.com",
    },
  });
}

function mergeTree(baseline, ours, theirs) {
  const result = runGit(
    ["merge-tree", "--write-tree", `--merge-base=${baseline}`, ours, theirs],
    { allowedExitCodes: [0, 1] },
  );
  const tree = result.stdout.split("\n", 1)[0].trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new SyncError(
      `git merge-tree 未回傳有效 tree：\n${result.stdout.trim()}`,
    );
  }
  return { conflict: result.status === 1, output: result.stdout.trim(), tree };
}

function buildMergedTree(baseline, upstreamRef) {
  const directMerge = mergeTree(baseline, "HEAD", upstreamRef);
  if (!directMerge.conflict) {
    return directMerge.tree;
  }

  // workflows 與客製 Worker 名稱由部署版本管理。遮罩這些欄位後
  // 再檢查三方合併；其他設定與程式碼仍保留完整衝突偵測。
  const maskedBaseline = temporaryCommitForTree(
    treeWithWorkflowsFrom(baseline, "HEAD", baseline),
  );
  const maskedUpstream = temporaryCommitForTree(
    treeWithWorkflowsFrom(upstreamRef, "HEAD", baseline),
  );
  const codeMerge = mergeTree(maskedBaseline, "HEAD", maskedUpstream);
  if (codeMerge.conflict) {
    throw new SyncError(
      `上游程式碼與部署 repository 發生衝突，已停止同步且不會推送：\n${codeMerge.output}`,
    );
  }

  console.log(
    "保留部署版本的 workflows 與客製 Worker 名稱，其他內容通過三方合併檢查。",
  );
  return codeMerge.tree;
}

function restoreInstalledWorkflows(sourceCommit) {
  runGit([
    "restore",
    "--source",
    sourceCommit,
    "--staged",
    "--worktree",
    "--",
    WORKFLOW_PATHSPEC,
  ]);
}

function verifyWorkflowsPreserved(sourceCommit) {
  const verification = runGit(
    ["diff", "--quiet", sourceCommit, "HEAD", "--", WORKFLOW_PATHSPEC],
    { allowedExitCodes: [0, 1] },
  );
  if (verification.status !== 0) {
    throw new SyncError(
      "同步後無法保留部署 repository 既有的 GitHub Actions workflows，已停止推送。",
    );
  }
}

function createSyncCommit(mergedTree, upstreamCommit, previousHead) {
  runGit(["read-tree", "--reset", "-u", mergedTree]);
  restoreInstalledWorkflows(previousHead);
  runGit([
    "commit",
    "--allow-empty",
    "-m",
    `同步上游版本 ${upstreamCommit.slice(0, 12)}`,
    "-m",
    `${UPSTREAM_TRAILER}: ${upstreamCommit}`,
  ]);
  verifyWorkflowsPreserved(previousHead);

  const commitAndParents = gitText([
    "rev-list",
    "--parents",
    "-n",
    "1",
    "HEAD",
  ]).split(" ");
  if (commitAndParents.length !== 2 || commitAndParents[1] !== previousHead) {
    throw new SyncError(
      "同步 commit 並非預期的單一 parent，為避免引入上游 workflow 歷史，已停止推送。",
    );
  }
}

function syncUpstream() {
  const upstreamUrl =
    process.env.SYNC_UPSTREAM_URL?.trim() || DEFAULT_UPSTREAM_URL;
  const upstreamBranch = process.env.SYNC_UPSTREAM_BRANCH?.trim() || "main";
  const targetBranch = process.env.SYNC_TARGET_BRANCH?.trim() || "main";
  const originRemote = process.env.SYNC_ORIGIN_REMOTE?.trim() || "origin";
  const backupBranch =
    process.env.SYNC_BACKUP_BRANCH?.trim() ||
    "backup-before-first-upstream-sync";
  const upstreamRemote = "upstream";
  const upstreamRef = `${upstreamRemote}/${upstreamBranch}`;

  assertCleanWorkingTree();

  const existingUpstream = runGit(["remote", "get-url", upstreamRemote], {
    allowedExitCodes: [0, 2],
  });
  if (existingUpstream.status === 0) {
    runGit(["remote", "set-url", upstreamRemote, upstreamUrl]);
  } else {
    runGit(["remote", "add", upstreamRemote, upstreamUrl]);
  }

  console.log(`取得上游 ${upstreamUrl} 的 ${upstreamBranch}...`);
  runGit([
    "fetch",
    "--no-tags",
    upstreamRemote,
    `+refs/heads/${upstreamBranch}:refs/remotes/${upstreamRef}`,
  ]);

  const before = gitText(["rev-parse", "HEAD"]);
  const upstreamCommit = gitText(["rev-parse", upstreamRef]);
  let baseline = findRecordedUpstreamCommit(upstreamRef);
  let requiresBaselineRecord = false;

  if (baseline) {
    console.log(`使用先前同步紀錄 ${baseline} 作為三方合併基準。`);
  } else {
    baseline = mergeBase("HEAD", upstreamRef);
    if (baseline) {
      console.log(`使用共同 Git 歷史 ${baseline} 作為三方合併基準。`);
    }
  }

  if (!baseline) {
    console.log("偵測到 Cloudflare source repo import，開始首次同步安全檢查。");
    const roots = gitText(["rev-list", "--max-parents=0", "HEAD"])
      .split("\n")
      .filter(Boolean);
    if (roots.length !== 1) {
      throw new SyncError(
        `目前部署 branch 有 ${roots.length} 個 root commits，無法安全判定首次部署版本，已停止同步。`,
      );
    }

    const rootCommit = roots[0];
    const matchingCommit = findMatchingUpstreamCommit(rootCommit, upstreamRef);
    if (!matchingCommit) {
      throw new SyncError(
        "部署 repository 的初始檔案無法對應任何上游版本（比對時已忽略 .github/workflows）。為避免覆蓋內容，本次同步已停止。",
      );
    }

    const changedPaths = changedPathsOutsideWorkflows(rootCommit);
    if (changedPaths.length > 0) {
      const preview = changedPaths.slice(0, 10).map((path) => `- ${path}`);
      if (changedPaths.length > preview.length) {
        preview.push(`- 另有 ${changedPaths.length - preview.length} 個檔案`);
      }
      throw new SyncError(
        `首次部署後已有 .github/workflows 以外的程式碼變更，無法安全自動接軌：\n${preview.join(
          "\n",
        )}\n請手動合併上游版本。`,
      );
    }

    console.log(`初始檔案對應上游 commit ${matchingCommit}，安全檢查通過。`);
    ensureBackupBranch(originRemote, backupBranch);
    baseline = matchingCommit;
    requiresBaselineRecord = true;
  }

  if (baseline === upstreamCommit && !requiresBaselineRecord) {
    console.log("目前已是最新版，不需要更新。");
    return;
  }

  const mergedTree = buildMergedTree(baseline, upstreamRef);
  createSyncCommit(mergedTree, upstreamCommit, before);

  console.log(`推送更新至 ${originRemote}/${targetBranch}...`);
  runGit(["push", originRemote, `HEAD:refs/heads/${targetBranch}`]);
  console.log("同步完成；Cloudflare Workers Builds 將自動重新部署。");
}

try {
  syncUpstream();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`同步失敗：${message}`);
  process.exitCode = 1;
}
