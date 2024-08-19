;;; $DOOMDIR/config.el -*- lexical-binding: t; -*-

;; Place your private configuration here! Remember, you do not need to run 'doom
;; sync' after modifying this file!


;; Some functionality uses this to identify you, e.g. GPG configuration, email
;; clients, file templates and snippets.
(setq user-full-name "0xgleb"
      user-mail-address "gleb.dianov@protonmail.com")

;; Doom exposes five (optional) variables for controlling fonts in Doom. Here
;; are the three important ones:
;;
;; + `doom-font'
;; + `doom-variable-pitch-font'
;; + `doom-big-font' -- used for `doom-big-font-mode'; use this for
;;   presentations or streaming.
;;
;; They all accept either a font-spec, font string ("Input Mono-12"), or xlfd
;; font string. You generally only need these two:
;; (setq doom-font (font-spec :family "monospace" :size 12 :weight 'semi-light)
;;       doom-variable-pitch-font (font-spec :family "sans" :size 13))

;; There are two ways to load a theme. Both assume the theme is installed and
;; available. You can either set `doom-theme' or manually load a theme with the
;; `load-theme' function. This is the default:

(setq doom-theme 'doom-ir-black)

;; bring back the vim s key
(remove-hook 'doom-first-input-hook #'evil-snipe-mode)


(defun my-change-number-at-point (change)
  (let ((number (number-at-point))
        (point (point)))
    (when number
      (progn
        (forward-word)
        (search-backward (number-to-string number))
        (replace-match (number-to-string (funcall change number)))
        (goto-char point)))))

(defun my-increment-number-at-point ()
  "Increment number at point like vim's C-a"
  (interactive)
  (my-change-number-at-point '1+))
(defun my-decrement-number-at-point ()
  "Decrement number at point like vim's C-x"
  (interactive)
  (my-change-number-at-point '1-))

(global-set-key (kbd "C-c a") 'my-increment-number-at-point)
(global-set-key (kbd "C-c x") 'my-decrement-number-at-point)


(map! :leader
      :desc "Jump to a character"
      "j" #'evil-avy-goto-word-or-subword-1)

;; Make evil-mode up/down operate in screen lines instead of logical lines
(define-key evil-motion-state-map "j" 'evil-next-visual-line)
(define-key evil-motion-state-map "k" 'evil-previous-visual-line)
;; Also in visual mode
(define-key evil-visual-state-map "j" 'evil-next-visual-line)
(define-key evil-visual-state-map "k" 'evil-previous-visual-line)


;; This determines the style of line numbers in effect. If set to `nil', line
;; numbers are disabled. For relative line numbers, set this to `relative'.
(setq display-line-numbers-type t)


(setq standard-indent 2)

(setq tab-width 2)


;; If you use `org' and don't want your org files in the default location below,
;; change `org-directory'. It must be set before org loads!
(setq org-directory "~/Dropbox/life/")

(setq treemacs-is-never-other-window nil)

(after! evil-org
  (remove-hook 'org-tab-first-hook #'+org-cycle-only-current-subtree-h))

(setq confirm-kill-emacs nil)


(add-hook! org-mode (yas-activate-extra-mode 'latex-mode))


(defun org-summary-todo (n-done n-not-done)
  "Switch entry to DONE when all subentries are done, to TODO otherwise."
  (let (org-log-done org-log-states)   ; turn off logging
    (org-todo (if (= n-not-done 0) "DONE" "TODO"))))

(add-hook 'org-after-todo-statistics-hook #'org-summary-todo)

(use-package! org
  ;; if you omit :defer, :hook, :commands, or :after, then the package is loaded
  ;; immediately. By using :hook here, the `hl-todo` package won't be loaded
  ;; until prog-mode-hook is triggered (by activating a major mode derived from
  ;; it, e.g. python-mode)
  ;; code here will run immediately
  :config
  ;; code here will run after the package is loaded

  (add-to-list 'org-modules 'org-habit t)

  (setq org-agenda-files
        '(directory-files (expand-file-name "~/Dropbox/life/") nil "^\\([^.]\\|\\.[^.]\\|\\.\\..\\)"))

  (setq org-capture-templates
        '(("t" "Todo" entry (file "~/Dropbox/life/aaye-inbox.org")
           "* TODO %?\n%U")

          ;; ("a" "Agenda for the day" entry (file "~/Dropbox/life/agenda.org")
          ;;     (file "~/Dropbox/templates/agenda.org"))

          ("b" "Beat" entry (file "~/Dropbox/life/music.org")
           (file "~/Dropbox/templates/beat.org"))

          ("c" "Content idea" entry (file "~/Dropbox/content-ideas.org")
           (file "~/Dropbox/templates/content-idea.org"))

          ("w" "Weekly review" entry (file "~/Dropbox/docs/writing/weekly.org")
           (file "~/Dropbox/templates/weekly.org"))

          ("j" "Journal" entry (file+datetree "~/Dropbox/docs/writing/journal.org")
           "* %?\nEntered on %U\n  %i")

          ("m" "Morning routine" entry (file+datetree "~/Dropbox/docs/writing/daily-journal.org")
           (file "~/Dropbox/templates/morning-routine.org"))

          ("p" "Morning Page" entry (file+datetree "~/Dropbox/docs/writing/morning-pages.org")
           "* Morning page\nEntered on %U\n\n%?")

          ;; ("e" "Evening routine" entry (file+datetree "~/Dropbox/daily-journal.org")
          ;;     (file "~/Dropbox/templates/evening-routine.org"))
          ))

  (setq org-startup-indented t)

  (setq org-agenda-window-setup 'other-window)

  (setq org-columns-default-format "%9TODO(State) %40ITEM(Task) %6CLOCKSUM(Clock) %8EFFORT(Effort){:}")

  (setq org-agenda-span 1)

  (setq org-agenda-start-day "+0d")

  (setq org-todo-keywords
        '((sequence "TODO" "NEXT" "WAITING" "|" "DONE" "CANCELLED")))

  (setq org-tag-alist
        '(("@quiet" . ?q)
          ("@loud" . ?l)
          ("@project" . ?p)
          ("@beats" . ?b)
          ("@filming" . ?f)
          ("@unfocused" . ?u)
          ("@marketing" . ?m)))

  (setq gtd/next-action-head "Next actions:")
  (setq gtd/waiting-head  "Waiting on:")
  (setq gtd/complete-head "Completed items:")
  (setq gtd/project-head "Projects:")
  ;; (setq gtd/someday-head "Someday/maybe:")

  (setq org-agenda-custom-commands
        '(
          ("g" "GTD view"
           ((agenda)
            (todo "NEXT" ((org-agenda-overriding-header gtd/next-action-head)))
            (todo "WAITING" ((org-agenda-overriding-header gtd/waiting-head)))
            (todo "DONE" ((org-agenda-overriding-header gtd/complete-head)))
            ;; (tags "@project-@someday" ((org-agenda-overriding-header gtd/project-head)))
            ;; (todo "SOMEDAY"  ((org-agenda-overriding-header gtd/someday-head)))
            ))))

  )

;; (after! haskell
;;   (setq! haskell-format-on-save t
;;          haskell-format-tool 'fourmolu))

(defun haskell-mode-fourmolu-buffer ()
  "Apply stylish-haskell to the current buffer.

Use `haskell-mode-stylish-haskell-path' to know where to find
stylish-haskell executable.  This function tries to preserve
cursor position and markers by using
`haskell-mode-buffer-apply-command'."
  (interactive)
  (message "haskell-mode-fourmolu-buffer called")
  (haskell-mode-buffer-apply-command "~/.local/bin/fourmolu"
                                     (list "-q" "--stdin-input-file" (message (buffer-file-name)))))

(defun custom-haskell-mode-before-save-handler ()
  "Function that will be called before buffer's saving."
  (when (eq major-mode #'haskell-mode)
    (ignore-errors (haskell-mode-fourmolu-buffer))))

;; (remove-hook 'before-save-hook 'haskell-mode-before-save-handler)
;; (add-hook! 'haskell-mode #'haskell-mode-fourmolu-buffer)

;; (add-hook 'prog-mode-hook 'format-all-mode)
;; (set-formatter! 'fourmolu "fourmolu -q --stdin-input-file %s" :modes '(haskell-mode))

;; (setq format-all-formats
;;   '((haskell-mode . fourmolu)))




;; (setq +python-ipython-repl-args '("-i" "--simple-prompt" "--no-color-info"))
;; (setq +python-jupyter-repl-args '("--simple-prompt"))




                                        ; copilot

(setq copilot-node-executable "~/.nvm/versions/node/v18.20.2/bin/node")

;; accept completion from copilot and fallback to company
(use-package! copilot
  :hook (prog-mode . copilot-mode)
  :bind (("C-TAB" . 'copilot-accept-completion-by-word)
         ("C-<tab>" . 'copilot-accept-completion-by-word)
         :map copilot-completion-map
         ("<tab>" . 'copilot-accept-completion)
         ("TAB" . 'copilot-accept-completion)))



(setq lsp-rust-analyzer-cargo-watch-command "clippy")
(setq lsp-rust-analyzer-cargo-extra-args ["--all-features"])

;; enable word/line wrapping
(setq global-word-wrap-whitespace-mode t)

;; Here are some additional functions/macros that could help you configure Doom:
;;
;; - `load!' for loading external *.el files relative to this one
;; - `use-package!' for configuring packages
;; - `after!' for running code after a package has loaded
;; - `add-load-path!' for adding directories to the `load-path', relative to
;;   this file. Emacs searches the `load-path' when you load packages with
;;   `require' or `use-package'.
;; - `map!' for binding new keys
;;
;; To get information about any of these functions/macros, move the cursor over
;; the highlighted symbol at press 'K' (non-evil users must press 'C-c c k').
;; This will open documentation for it, including demos of how they are used.
;;
;; You can also try 'gd' (or 'C-c c d') to jump to their definition and see how
;; they are implemented.
