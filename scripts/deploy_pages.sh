#!/bin/bash
# Deploy the latest static export to both GitHub Pages repos (lenia + lenia-pond).
set -e

EXPORT=/home/z/my-project/.next-export
STAMP="$(date -u '+%Y-%m-%d %H:%M UTC')"

deploy() {
  local dir="$1" msg="$2"
  echo "=== Deploying $dir ==="
  cd "$dir"
  # Remove everything except .git
  find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
  # Copy fresh export
  cp -r "$EXPORT"/. .
  # Jekyll must not drop the _next folder
  touch .nojekyll
  git add -A
  if git diff --cached --quiet; then
    echo "No changes to commit."
  else
    git -c user.name="Genocide12" -c user.email="Genocide12@users.noreply.github.com" \
      commit -m "$msg"
    git push origin gh-pages
    echo "Pushed: $(git log -1 --format='%ci %h %s')"
  fi
}

deploy /tmp/ghpages3 "deploy $STAMP: оптимизация (WebGL-рендер, буферы в дело, ноль аллокаций в кадре) и скорость времени ×1…×100 (клавиши 1–6)"
deploy /tmp/ghpages2 "deploy $STAMP: оптимизация и скорость времени ×1…×100 — синхронизация с lenia-pond"

echo "=== Done ==="
