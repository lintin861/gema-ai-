const setupMessage = document.getElementById("setupMessage");

fetch("/api/auth/me")
    .then(async response => {
        const data = await response.json();
        if (response.ok) {
            window.location.replace("/chat.html");
            return;
        }
        if (response.status !== 401) {
            setupMessage.textContent = data.error || "Account services are not available right now.";
        }
    })
    .catch(() => {
        setupMessage.textContent = "Could not check your account. Please try again.";
    });
