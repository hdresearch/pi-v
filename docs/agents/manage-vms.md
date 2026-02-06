# I need to manage Vers VMs

## Create a VM
```
vers_vm_create --mem_size_mib 4096 --fs_size_mib 8192 --wait_boot true
```
Returns `vm_id`. Wait for boot if you need SSH immediately.

## Run commands on a VM
```
vers_vm_use --vmId <vmId>
bash --command "ls /root"
read --path /root/file.txt
vers_vm_local
```
After `vers_vm_use`, all `bash`/`read`/`edit`/`write` tools execute on the VM. `vers_vm_local` switches back.

## Copy files to/from a VM
```
vers_vm_copy --localPath ./file.txt --remotePath /root/file.txt --direction to_vm
vers_vm_copy --localPath ./output/ --remotePath /root/output/ --direction from_vm
```

## Snapshot a VM
```
vers_vm_commit --vmId <vmId>
```
Returns `commit_id`. Use it to restore later.

## Restore from a snapshot
```
vers_vm_restore --commitId <commitId>
```
Returns a new `vm_id` with the snapshotted state.

## Clone a running VM
```
vers_vm_branch --vmId <vmId>
```
Returns a new `vm_id`. Same state as the original, copy-on-write.

## Pause and resume
```
vers_vm_state --vmId <vmId> --state Paused
vers_vm_state --vmId <vmId> --state Running
```

## List all VMs
```
vers_vms
```

## Delete a VM
```
vers_vm_delete --vmId <vmId>
```

## If SSH times out

The VM might still be booting. Wait 10-15 seconds and try `vers_vm_use` again.

## If you need to SSH manually

```bash
ssh -i /tmp/vers-ssh-keys/vers-<vmId-prefix>.pem \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o "ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null" \
  root@<vmId>.vm.vers.sh
```
