terraform {
  required_providers {
    coder = {
      source = "coder/coder"
    }
    docker = {
      source = "kreuzwerker/docker"
    }
  }
}

locals {
  # Linux user inside codercom/example-base:ubuntu
  linux_user = "coder"
  repo_url   = "git@github.com:aavendano/pi.git"
}

provider "docker" {}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"
  startup_script = <<-EOT
    set -e

    if [ ! -f ~/.init_done ]; then
      cp -rT /etc/skel ~
      touch ~/.init_done
    fi

    # Prefer HTTPS for the public repo when SSH keys are not present in the workspace.
    mkdir -p ~/.ssh
    chmod 700 ~/.ssh
    if [ ! -f ~/.ssh/known_hosts ] || ! grep -q github.com ~/.ssh/known_hosts; then
      ssh-keyscan -t ed25519,rsa github.com >> ~/.ssh/known_hosts 2>/dev/null || true
    fi
  EOT

  env = {
    GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL    = "${data.coder_workspace_owner.me.email}"
    GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL = "${data.coder_workspace_owner.me.email}"
  }

  metadata {
    display_name = "CPU Usage"
    key          = "0_cpu_usage"
    script       = "coder stat cpu"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "RAM Usage"
    key          = "1_ram_usage"
    script       = "coder stat mem"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Home Disk"
    key          = "3_home_disk"
    script       = "coder stat disk --path $${HOME}"
    interval     = 60
    timeout      = 1
  }
}

# https://registry.coder.com/modules/coder/git-clone
# Clones git@github.com:aavendano/pi.git (falls back to HTTPS if SSH is unavailable).
module "git-clone" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/git-clone/coder"
  version  = "2.0.5"
  agent_id = coder_agent.main.id
  url      = local.repo_url

  pre_clone_script = <<-EOT
    #!/usr/bin/env bash
    set -euo pipefail
    # Public repo: if the workspace has no SSH key, rewrite SSH GitHub URLs to HTTPS.
    if [ ! -f "$HOME/.ssh/id_ed25519" ] && [ ! -f "$HOME/.ssh/id_rsa" ] && [ -z "$${SSH_AUTH_SOCK:-}" ]; then
      git config --global url."https://github.com/".insteadOf "git@github.com:"
      echo "No SSH key in workspace; git@github.com -> https://github.com"
    fi
  EOT
}

# https://registry.coder.com/modules/coder/code-server
# Opens the cloned pi repo so AGENTS.md / .pi config load from that checkout.
module "code-server" {
  count    = data.coder_workspace.me.start_count
  source   = "registry.coder.com/coder/code-server/coder"
  version  = "1.6.0"
  agent_id = coder_agent.main.id

  order        = 1
  folder       = "/home/${local.linux_user}/${module.git-clone[count.index].folder_name}"
  subdomain    = false
  display_name = "code-server"
  slug         = "code-server"
}

resource "docker_volume" "home_volume" {
  name = "coder-${data.coder_workspace.me.id}-home"
  lifecycle {
    ignore_changes = all
  }
  labels {
    label = "coder.owner"
    value = data.coder_workspace_owner.me.name
  }
  labels {
    label = "coder.owner_id"
    value = data.coder_workspace_owner.me.id
  }
  labels {
    label = "coder.workspace_id"
    value = data.coder_workspace.me.id
  }
  labels {
    label = "coder.workspace_name_at_creation"
    value = data.coder_workspace.me.name
  }
}

resource "docker_container" "workspace" {
  count    = data.coder_workspace.me.start_count
  image    = "codercom/example-base:ubuntu"
  name     = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  hostname = data.coder_workspace.me.name
  entrypoint = ["sh", "-c", replace(coder_agent.main.init_script, "/localhost|127\\.0\\.0\\.1/", "host.docker.internal")]
  env        = ["CODER_AGENT_TOKEN=${coder_agent.main.token}"]
  host {
    host = "host.docker.internal"
    ip   = "host-gateway"
  }
  volumes {
    container_path = "/home/coder"
    volume_name    = docker_volume.home_volume.name
    read_only      = false
  }

  labels {
    label = "coder.owner"
    value = data.coder_workspace_owner.me.name
  }
  labels {
    label = "coder.owner_id"
    value = data.coder_workspace_owner.me.id
  }
  labels {
    label = "coder.workspace_id"
    value = data.coder_workspace.me.id
  }
  labels {
    label = "coder.workspace_name"
    value = data.coder_workspace.me.name
  }
}
