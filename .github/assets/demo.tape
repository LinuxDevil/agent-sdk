Output .github/assets/demo.gif

Require npm
Require npx

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 820
Set Padding 24
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"
Set WaitTimeout 120s
Set WaitPattern /^\$$/

Hide
Type "export PS1='$ ' npm_config_yes=true npm_config_loglevel=error npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false" Enter
Type "export TMPDIR=/tmp DEMO_ASSETS=$PWD/.github/assets/demo && rm -rf /tmp/lousho-demo && mkdir /tmp/lousho-demo && cd /tmp/lousho-demo && clear" Enter
Wait
Show

Type "npm create lousho@latest demo -- --template tools --provider ollama --yes --no-install --no-git" Sleep 400ms Enter
Wait
Sleep 2s

Hide
Type "cd demo && npm install --silent >/dev/null 2>&1" Enter
Wait
Type "sed -i.bak 's#ollama/llama3#ollama/llama3.2#' src/agent.ts && rm src/agent.ts.bak" Enter
Type "cp $DEMO_ASSETS/words.eval.txt src/words.eval.ts && mkdir -p src/__cassettes__/word-count" Enter
Type "cp $DEMO_ASSETS/word-count.cassette.json src/__cassettes__/word-count/default.json && clear" Enter
Wait
Show

Type "cat src/words.eval.ts" Sleep 300ms Enter
Sleep 2s
Type "npx lousho eval --replay" Sleep 300ms Enter
Wait
Sleep 3s

Type "clear" Enter
Type "sed -i.bak 's/when they help./when they help. Be brief./' src/agent.ts" Sleep 300ms Enter
Type "npx lousho eval --replay" Sleep 300ms Enter
Wait
Sleep 6s
