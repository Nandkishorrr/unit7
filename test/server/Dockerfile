# A disposable "VPS" for tests: SSH + its own Docker daemon (docker-in-docker), so Unit7 deploys
# to it exactly like a real server and nothing touches the host's containers.
FROM docker:29-dind
RUN apk add --no-cache openssh bash curl git python3 coreutils procps \
 && ssh-keygen -A \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
 && echo 'AllowTcpForwarding yes' >> /etc/ssh/sshd_config \
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh
COPY start.sh /start.sh
EXPOSE 22 80 443
ENTRYPOINT ["/start.sh"]
