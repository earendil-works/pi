import { PI_PROVIDERS, THINKING_LEVELS } from "@earendil-works/pi-hub";

export const ZSH_COMPLETION = `#compdef pipi

_pipi() {
  local context state state_descr line
  typeset -A opt_args

  local -a commands
  commands=(
    'profile:Manage pi agent profiles'
    'use:Set a profile as the default'
    'unuse:Unset the default profile (run plain pi)'
    'completion:Print shell completion script'
    'install:Install extension source and add to settings'
    'remove:Remove extension source from settings'
    'uninstall:Alias for remove'
    'update:Update pi, extensions, or model catalogs'
    'list:List installed extensions from settings'
    'config:Open TUI to enable/disable package resources'
    'auth:Print credentials or check provider readiness'
  )

  local -a profile_subcmds
  profile_subcmds=(
    'add:Add or update a profile'
    'update:Update fields of an existing profile'
    'list:List all profiles'
    'view:View full details of a profile'
    'remove:Remove a profile'
    'rename:Rename a profile'
    'default:Set the default profile'
  )

  local -a global_spec
  global_spec=(
    '--provider[Provider name]:provider:(${PI_PROVIDERS.join(" ")})'
    '--model[Model pattern or ID]:model:'
    '--api-key[API key]:key:'
    '--system-prompt[System prompt]:text:'
    '--append-system-prompt[Append text to the system prompt]:text:'
    '--mode[Output mode]:mode:(text json rpc)'
    '(-p --print)'{-p,--print}'[Non-interactive mode]'
    '(-c --continue)'{-c,--continue}'[Continue previous session]'
    '(-r --resume)'{-r,--resume}'[Select a session to resume]'
    '--session[Session file or partial UUID]:session:'
    '--session-id[Exact project session ID]:id:'
    '--fork[Fork session file or partial UUID]:session:'
    '--session-dir[Directory for session storage]:dir:_files -/'
    '--no-session[Do not save session (ephemeral)]'
    '(-n --name)'{-n,--name}'[Session display name]:name:'
    '--models[Comma-separated model patterns for Ctrl+P cycling]:patterns:'
    '(-nt --no-tools)'{-nt,--no-tools}'[Disable all tools]'
    '(-nbt --no-builtin-tools)'{-nbt,--no-builtin-tools}'[Disable built-in tools, keep extension tools]'
    '(-t --tools)'{-t,--tools}'[Comma-separated tool allowlist]:tools:'
    '(-xt --exclude-tools)'{-xt,--exclude-tools}'[Comma-separated tool denylist]:tools:'
    '--thinking[Thinking level]:level:(${THINKING_LEVELS.join(" ")})'
    '(-e --extension)'{-e,--extension}'[Load extension file]:path:_files'
    '(-ne --no-extensions)'{-ne,--no-extensions}'[Disable extension discovery]'
    '--skill[Load skill file or directory]:path:_files'
    '(-ns --no-skills)'{-ns,--no-skills}'[Disable skills discovery and loading]'
    '--prompt-template[Load prompt template file or directory]:path:_files'
    '(-np --no-prompt-templates)'{-np,--no-prompt-templates}'[Disable prompt template discovery]'
    '--theme[Load theme file or directory]:path:_files'
    '--use-theme[Initial interactive theme]:name:'
    '--no-themes[Disable theme discovery and loading]'
    '(-nc --no-context-files)'{-nc,--no-context-files}'[Disable AGENTS.md and CLAUDE.md discovery]'
    '--export[Export session file to HTML]:file:_files'
    '--list-models[List available models]:search:'
    '--verbose[Force verbose startup]'
    '--tui-mode[TUI mode]:mode:(regular fullscreen)'
    '(-a --approve)'{-a,--approve}'[Trust project-local files for this run]'
    '(-na --no-approve)'{-na,--no-approve}'[Ignore project-local files for this run]'
    '--offline[Disable startup network operations]'
    '--as[Run this invocation under a profile]:profile:_pipi_profiles'
    '(-h --help)'{-h,--help}'[Show help]'
    '(-v --version)'{-v,--version}'[Show version number]'
  )

  _pipi_profiles() {
    local profiles_file="\${PI_HUB_PROFILES_FILE:-$HOME/.pi/profiles.json}"
    if [[ -f "$profiles_file" ]]; then
      local -a names
      names=(\${(f)"$(command jq -r '.profiles | keys[]' "$profiles_file" 2>/dev/null)"})
      _describe -t profiles 'profile' names
    fi
  }

  _pipi_models_for_profile() {
    local profile_name="$1"
    local profiles_file="\${PI_HUB_PROFILES_FILE:-$HOME/.pi/profiles.json}"
    if [[ -f "$profiles_file" && -n "$profile_name" ]]; then
      local -a models
      models=(\${(f)"$(command jq -r --arg p "$profile_name" '(.profiles[$p].models // [ .profiles[$p].model ] )[]? // empty' "$profiles_file" 2>/dev/null)"})
      _describe -t models 'model' models
    fi
  }

  _arguments -C -S \\
    "\${global_spec[@]}" \\
    '1: :->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe -t commands 'pipi command' commands
      ;;
    args)
      case $words[1] in
        profile)
          if (( CURRENT == 2 )); then
            _describe -t profile-subcmds 'profile subcommand' profile_subcmds
          elif [[ $words[2] == "view" || $words[2] == "remove" ]]; then
            _pipi_profiles
          elif [[ $words[2] == "default" ]]; then
            _pipi_profiles
          elif [[ $words[2] == "rename" ]]; then
            if (( CURRENT == 3 )); then
              _pipi_profiles
            fi
          elif [[ $words[2] == "add" ]]; then
            if (( CURRENT == 3 )); then
              # profile name is free text; nothing to complete
              return 1
            else
              words=("stub" $words[3,-1])
              (( CURRENT-- ))
              _arguments -C -S \\
                '1:profile:' \\
                '(-m --model)*'{-m,--model}'[Model ID]:model:' \\
                '(-t --token)'{-t,--token}'[API key / token]:token:' \\
                '(-u --url)'{-u,--url}'[Base URL]:url:' \\
                '(-p --provider)'{-p,--provider}'[pi provider id]:provider:(${PI_PROVIDERS.join(" ")})' \\
                '--thinking[Thinking level]:level:(${THINKING_LEVELS.join(" ")})'
            fi
          elif [[ $words[2] == "update" ]]; then
            if (( CURRENT == 3 )); then
              _pipi_profiles
            else
              words=("stub" $words[3,-1])
              (( CURRENT-- ))
              _arguments -C -S \\
                '1:profile:_pipi_profiles' \\
                '(-m --model)*'{-m,--model}'[Model ID]:model:->profileModel' \\
                '(-d --delete-model)*'{-d,--delete-model}'[Remove model ID]:model:->profileModel' \\
                '(-t --token)'{-t,--token}'[API key / token]:token:' \\
                '(-u --url)'{-u,--url}'[Base URL]:url:' \\
                '(-p --provider)'{-p,--provider}'[pi provider id]:provider:(${PI_PROVIDERS.join(" ")})' \\
                '--thinking[Thinking level]:level:(${THINKING_LEVELS.join(" ")})'
              case $state in
                profileModel)
                  _pipi_models_for_profile $line[1]
                  ;;
              esac
            fi
          fi
          ;;
        use)
          _pipi_profiles
          ;;
        completion)
          _arguments -C -S \\
            '1:shell:(bash zsh)'
          ;;
        auth)
          if (( CURRENT == 2 )); then
            _arguments -C -S \\
              '1:auth command:(check print-api-key print-bearer-token)'
          else
            _arguments -C -S \\
              "\${global_spec[@]}"
          fi
          ;;
        update)
          if (( CURRENT == 2 )); then
            _arguments -C -S \\
              '1:update target:(self pi)' \\
              '*:extension source:_files'
          else
            _files
          fi
          ;;
        install|remove|uninstall)
          _files
          ;;
        *)
          _arguments -C -S \\
            "\${global_spec[@]}" \\
            '*:files:_files'
          ;;
      esac
      ;;
  esac
}

compdef _pipi pipi
`;
