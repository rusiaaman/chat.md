"""Allows ``python -m chatmd``, which is how the background listener is spawned."""

from .cli.main import main

if __name__ == "__main__":
    main()
