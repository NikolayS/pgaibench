# Official postgres image plus pg_cron from the PGDG apt repository
# that the image already configures.
ARG PG_TAG=18.4
FROM postgres:${PG_TAG}
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-18-cron \
  && rm -rf /var/lib/apt/lists/*
