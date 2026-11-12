#!/bin/bash
# Деплой статической сборки в ЕДИНСТВЕННЫЙ репозиторий lenia-pond.
# Старый репозиторий lenia больше не обновляется — там лежит редирект.
set -e

EXPORT=/home/z/my-project/.next-export
STAMP="$(date -u '+%Y-%m-%d %H:%M UTC')"
DIR=/tmp/ghpages3

echo "=== Deploying $DIR ==="
cd "$DIR"
find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -r "$EXPORT"/. .
touch .nojekyll
git add -A
if git diff --cached --quiet; then
  echo "No changes to commit."
else
  git -c user.name="Genocide12" -c user.email="Genocide12@users.noreply.github.com" \
    commit -m "deploy $STAMP"
  git push origin gh-pages
  echo "Pushed: $(git log -1 --format='%ci %h %s')"
fi
echo "=== Done ==="
