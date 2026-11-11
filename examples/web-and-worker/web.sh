#!/bin/sh
apt-get update && apt-get install -y nginx
echo "hello from ${HOSTNAME:-paibot-iac}" > /var/www/html/index.html
