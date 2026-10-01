import { PI_PROVIDERS, THINKING_LEVELS } from "@earendil-works/pi-hub";

export const BASH_COMPLETION = `_pipi_profile_names() {
  local profiles_file="\${PI_HUB_PROFILES_FILE:-$HOME/.pi/profiles.json}"
  if [[ -f "$profiles_file" ]]; then
    command python3 -c "
import json
data = json.load(open('$profiles_file'))
for name in data.get('profiles', {}):
    print(name)
" 2>/dev/null
  fi
}

_pipi_profiles() {
  COMPREPLY=($(compgen -W "$(_pipi_profile_names)" -- "\${cur}"))
}

_pipi_models_for_profile() {
  local profile_name="$1"
  local profiles_file="\${PI_HUB_PROFILES_FILE:-$HOME/.pi/profiles.json}"
  if [[ -f "$profiles_file" && -n "$profile_name" ]]; then
    local models
    models=$(command python3 -c "
import json
data = json.load(open('$profiles_file'))
p = data.get('profiles', {}).get('$profile_name', {})
models = p.get('models')
if isinstance(models, list):
    for m in models:
        if m:
            print(m)
else:
    m = p.get('model')
    if m:
        print(m)
" 2>/dev/null)
    COMPREPLY=($(compgen -W "$models" -- "\${cur}"))
  fi
}

_pipi() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  local commands="profile use unuse completion install remove uninstall update list config auth"
  local global_flags="--provider --model --api-key --system-prompt --append-system-prompt --mode --print -p --continue -c --resume -r --session --session-id --fork --session-dir --no-session --name -n --models --no-tools -nt --no-builtin-tools -nbt --tools -t --exclude-tools -xt --thinking --extension -e --no-extensions -ne --skill --no-skills -ns --prompt-template --no-prompt-templates -np --theme --use-theme --no-themes --no-context-files -nc --export --list-models --verbose --tui-mode --approve -a --no-approve -na --offline --as --help -h --version -v"
  local profile_subcmds="add update list view remove rename default"
  local thinking_levels="${THINKING_LEVELS.join(" ")}"
  local providers="${PI_PROVIDERS.join(" ")}"
  local modes="text json rpc"

  # Value completion for a preceding global option.
  case "$prev" in
    --provider)
      COMPREPLY=($(compgen -W "$providers" -- "$cur")); return 0 ;;
    --thinking)
      COMPREPLY=($(compgen -W "$thinking_levels" -- "$cur")); return 0 ;;
    --mode)
      COMPREPLY=($(compgen -W "$modes" -- "$cur")); return 0 ;;
    --tui-mode)
      COMPREPLY=($(compgen -W "regular fullscreen" -- "$cur")); return 0 ;;
    --as)
      _pipi_profiles; return 0 ;;
    --session-dir)
      COMPREPLY=($(compgen -d -- "$cur")); return 0 ;;
    --export|--extension|--skill|--prompt-template|--theme)
      COMPREPLY=($(compgen -f -- "$cur")); return 0 ;;
  esac

  # Top level
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    if [[ "$cur" == -* ]]; then
      COMPREPLY=($(compgen -W "$global_flags" -- "$cur"))
    else
      COMPREPLY=($(compgen -W "$commands $global_flags" -- "$cur"))
    fi
    return 0
  fi

  local cmd="\${COMP_WORDS[1]}"

  case "$cmd" in
    profile)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$profile_subcmds" -- "$cur"))
      elif [[ "$prev" == "view" || "$prev" == "remove" ]]; then
        _pipi_profiles
      elif [[ "$prev" == "default" ]]; then
        COMPREPLY=($(compgen -W "--built-in $(_pipi_profile_names)" -- "$cur"))
      elif [[ "$prev" == "rename" ]]; then
        _pipi_profiles
      elif [[ "$prev" == "profile" ]]; then
        COMPREPLY=($(compgen -W "$profile_subcmds" -- "$cur"))
      elif [[ "\${COMP_WORDS[2]}" == "update" && \${COMP_CWORD} -eq 3 ]]; then
        _pipi_profiles
      elif [[ "\${COMP_WORDS[2]}" == "update" ]]; then
        if [[ "$prev" == "--thinking" ]]; then
          COMPREPLY=($(compgen -W "$thinking_levels" -- "$cur"))
        elif [[ "$prev" == "--provider" || "$prev" == "-p" ]]; then
          COMPREPLY=($(compgen -W "$providers" -- "$cur"))
        elif [[ "$prev" == "--model" || "$prev" == "-m" || "$prev" == "--delete-model" || "$prev" == "-d" ]]; then
          _pipi_models_for_profile "\${COMP_WORDS[3]}"
        else
          local update_opts="--model -m --delete-model -d --token -t --url -u --provider -p --thinking"
          COMPREPLY=($(compgen -W "$update_opts" -- "$cur"))
        fi
      elif [[ "\${COMP_WORDS[2]}" == "add" && \${COMP_CWORD} -gt 3 ]]; then
        if [[ "$prev" == "--thinking" ]]; then
          COMPREPLY=($(compgen -W "$thinking_levels" -- "$cur"))
        elif [[ "$prev" == "--provider" || "$prev" == "-p" ]]; then
          COMPREPLY=($(compgen -W "$providers" -- "$cur"))
        else
          local add_opts="--model -m --token -t --url -u --provider -p --thinking"
          COMPREPLY=($(compgen -W "$add_opts" -- "$cur"))
        fi
      fi
      ;;
    use)
      if [[ "$prev" != "--built-in" ]]; then
        COMPREPLY=($(compgen -W "--built-in $(_pipi_profile_names)" -- "$cur"))
      fi
      ;;
    completion)
      COMPREPLY=($(compgen -W "bash zsh" -- "$cur"))
      ;;
    auth)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "check print-api-key print-bearer-token" -- "$cur"))
      else
        COMPREPLY=($(compgen -W "$global_flags" -- "$cur"))
      fi
      ;;
    update)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=($(compgen -W "self pi" -- "$cur"))
      else
        COMPREPLY=($(compgen -f -- "$cur"))
      fi
      ;;
    install|remove|uninstall)
      COMPREPLY=($(compgen -f -- "$cur"))
      ;;
    list|config|unuse)
      COMPREPLY=($(compgen -W "$global_flags" -- "$cur"))
      ;;
    *)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "$global_flags" -- "$cur"))
      else
        COMPREPLY=($(compgen -f -- "$cur"))
      fi
      ;;
  esac

  return 0
}

complete -F _pipi pipi
`;
