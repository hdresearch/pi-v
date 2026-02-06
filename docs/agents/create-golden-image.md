# I need to create a golden VM image

A golden image is a snapshotted VM with Node.js, pi, and tools pre-installed. Branch from it to get instant ready-to-code VMs.

## Steps

1. Create a VM:
```
vers_vm_create --mem_size_mib 4096 --fs_size_mib 8192 --wait_boot true
```

2. Connect:
```
vers_vm_use --vmId <vmId>
```

3. Install everything:
```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl wget build-essential ripgrep jq tree python3 openssh-client ca-certificates gnupg

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

npm install -g @mariozechner/pi-coding-agent

git config --global user.name "pi-agent"
git config --global user.email "pi-agent@vers.sh"

mkdir -p /root/workspace /root/.pi/agent/extensions /root/.swarm/status
echo '{"vms":[]}' > /root/.swarm/registry.json
```

4. Copy extensions into the VM:
```
vers_vm_copy --localPath <path-to-vers-vm.ts> --remotePath /root/.pi/agent/extensions/vers-vm.ts --direction to_vm
vers_vm_copy --localPath <path-to-vers-swarm.ts> --remotePath /root/.pi/agent/extensions/vers-swarm.ts --direction to_vm
```

5. Snapshot:
```
vers_vm_local
vers_vm_commit --vmId <vmId>
```

6. Save the returned `commit_id`. This is your golden image. Use it with `vers_swarm_spawn` or `vers_vm_restore`.

## If you need to update the golden image

Restore from the old commit, make changes, commit again. You get a new commit ID.

## If the VM runs out of disk

Increase `fs_size_mib` when creating. 8192 (8GB) is enough for most setups. Use 16384 for projects with large dependencies.
