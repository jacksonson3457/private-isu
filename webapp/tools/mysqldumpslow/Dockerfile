FROM oraclelinux:9-slim

RUN microdnf install -y curl \
    && curl -fsSL \
      https://repo.mysql.com/yum/mysql-9.7-community/el/9/x86_64/mysql97-community-release-el9-1.noarch.rpm \
      -o /tmp/mysql-community-release.rpm \
    && rpm -Uvh /tmp/mysql-community-release.rpm \
    && rm /tmp/mysql-community-release.rpm \
    && microdnf install -y mysql-community-server \
    && microdnf clean all

ENTRYPOINT ["mysqldumpslow"]
