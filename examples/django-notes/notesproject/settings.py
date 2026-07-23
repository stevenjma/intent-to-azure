import os

import dj_database_url

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-not-a-secret")
DEBUG = os.environ.get("DJANGO_DEBUG") == "1"
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "notes",
]

ROOT_URLCONF = "notesproject.urls"

DATABASES = {
    "default": dj_database_url.config(default=os.environ.get("DATABASE_URL", "")),
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
