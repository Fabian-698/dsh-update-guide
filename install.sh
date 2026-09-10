#!/usr/bin/env bash
# dsh-update-guide 安装/更新脚本 —— 把技能放进 DSH 的技能目录。
#
# 默认目标: ${DSH_SKILLS_DIR:-${DSH_HOME:-$HOME/.dsh}/skills}/dsh-update-guide
#
# 用法:
#   bash install.sh                       安装/更新(目标已存在且未加 --force 时拒绝,并提示如何覆盖)
#   bash install.sh --dry-run             只打印将要做什么,不改任何文件
#   bash install.sh --force               目标已存在时先备份为 dsh-update-guide.bak-<时间戳> 再覆盖
#   bash install.sh --from <目录>          从本地目录复制(可为仓库根、技能目录或技能族的上一级)
#   bash install.sh --ref <tag|branch>     指定克隆的 ref(默认 main)
#   bash install.sh --repo <git-url>       覆盖仓库地址(镜像 / 私有 fork)
#   bash install.sh --no-test             跳过安装后的 selftest
#   bash install.sh -h | --help           显示帮助
#
# 只使用 git / cp / chmod / node,不写 DSH 的会话数据。
set -euo pipefail

REPO_URL="${DSH_UPDATE_GUIDE_REPO:-https://github.com/Fabian-698/dsh-update-guide.git}"
REF="main"
FROM=""
DRY_RUN=0
FORCE=0
RUN_TEST=1

die() { printf 'install.sh: %s\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }
usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --no-test) RUN_TEST=0 ;;
    --from) shift; FROM="${1:-}"; [ -n "$FROM" ] || die "--from 需要一个目录参数" ;;
    --ref) shift; REF="${1:-}"; [ -n "$REF" ] || die "--ref 需要一个参数" ;;
    --repo) shift; REPO_URL="${1:-}"; [ -n "$REPO_URL" ] || die "--repo 需要一个参数" ;;
    -h|--help) usage ;;
    *) die "未知参数: $1(用 --help 看用法)" ;;
  esac
  shift
done

SKILLS_DIR="${DSH_SKILLS_DIR:-${DSH_HOME:-$HOME/.dsh}/skills}"
TARGET="$SKILLS_DIR/dsh-update-guide"
TMP=""

cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; return 0; }
trap cleanup EXIT

# 解析来源目录:必须是包含 SKILL.md 的技能目录
resolve_source() {
  local dir="$1"
  [ -d "$dir" ] || die "目录不存在: $dir"
  if [ -f "$dir/SKILL.md" ]; then printf '%s' "$dir"; return 0; fi
  if [ -f "$dir/skills/dsh-update-guide/SKILL.md" ]; then printf '%s' "$dir/skills/dsh-update-guide"; return 0; fi
  if [ -f "$dir/dsh-update-guide/SKILL.md" ]; then printf '%s' "$dir/dsh-update-guide"; return 0; fi
  die "$dir 里找不到 SKILL.md(既不是技能目录,也不含 skills/dsh-update-guide/)"
}

SRC=""
if [ -n "$FROM" ]; then
  SRC="$(resolve_source "$FROM")"
  say "[来源] 本地目录: $SRC"
else
  command -v git >/dev/null 2>&1 || die "需要 git;或改用 --from <本地技能目录>"
  TMP="$(mktemp -d)"
  say "[来源] $REPO_URL @ $REF"
  if [ "$DRY_RUN" = 1 ]; then
    say "  (dry-run) git clone --depth 1 --branch $REF $REPO_URL -> 临时目录"
    SRC="$TMP/repo/skills/dsh-update-guide"
  else
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$TMP/repo" >/dev/null 2>&1 || die "git clone 失败: $REPO_URL ($REF)"
    SRC="$(resolve_source "$TMP/repo")"
  fi
fi

say "[目标] $TARGET"
if [ -e "$TARGET" ]; then
  if [ "$FORCE" != 1 ]; then
    die "目标已存在,未改动。加 --force 覆盖(会先备份为 $TARGET.bak-<时间戳>);
        若该目录本身是 git clone,也可直接: git -C \"$TARGET\" pull --ff-only"
  fi
  BAK="$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
  say "[备份] $TARGET -> $BAK"
  [ "$DRY_RUN" = 1 ] || mv "$TARGET" "$BAK"
fi

if [ "$DRY_RUN" = 1 ]; then
  say "  (dry-run) 复制 $SRC -> $TARGET,并 chmod 755 scripts/*.mjs"
else
  mkdir -p "$SKILLS_DIR"
  cp -R "$SRC" "$TARGET"
  chmod 755 "$TARGET/scripts/"*.mjs 2>/dev/null || true
  chmod 755 "$TARGET/scripts/gates/"*.mjs 2>/dev/null || true
  say "[安装] 已写入 $TARGET"
fi

# 兄弟技能提示(缺失不影响本技能跑通:闸门 shim 会回退到 scripts/gates/)
missing=""
for s in dsh-foundations dsh-session-logs dsh-config-assembly dsh-run; do
  [ -d "$SKILLS_DIR/$s" ] || missing="$missing $s"
done
if [ -n "$missing" ]; then
  say "[提示] 未发现兄弟技能:$missing"
  say "       闸门将使用内置副本 scripts/gates/;想要 owner 版请把技能族装到同一目录(见 SKILL.md 的「版本与依赖」)。"
fi

if [ "$RUN_TEST" = 1 ] && [ "$DRY_RUN" != 1 ]; then
  if command -v node >/dev/null 2>&1; then
    say "[自测] node scripts/selftest.mjs"
    if ( cd "$TARGET" && node scripts/selftest.mjs ); then
      say "[自测] ALL PASS"
    else
      say "[警告] 自测未全过,请检查 Node 版本(需 >= 18)。"
    fi
  else
    say "[警告] 未找到 node,跳过自测(技能脚本需要 Node >= 18)。"
  fi
fi

say ""
say "下一步:"
say "  node \"$TARGET/scripts/scan-upgrade.mjs\" --profile web    # 一键体检"
say "  详细流程见 \"$TARGET/SKILL.md\" 与仓库 README。"
