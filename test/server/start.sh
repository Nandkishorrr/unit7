#!/bin/sh
# AUTHORIZED_KEY comes from the test harness; sshd in the background, dockerd in the foreground.
echo "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
/usr/sbin/sshd
exec dockerd-entrypoint.sh
