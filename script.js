/* ==========================================
   ZAVORA SOCIAL - HOMEPAGE JAVASCRIPT
========================================== */


/* ================= MOBILE MENU ================= */

const menuBtn = document.getElementById("menuBtn");
const mobileMenu = document.getElementById("mobileMenu");

if (menuBtn && mobileMenu) {

    menuBtn.addEventListener("click", () => {

        mobileMenu.classList.toggle("show");

        const icon = menuBtn.querySelector("i");

        if (mobileMenu.classList.contains("show")) {
            icon.classList.remove("fa-bars");
            icon.classList.add("fa-xmark");
        } else {
            icon.classList.remove("fa-xmark");
            icon.classList.add("fa-bars");
        }

    });


    /* Close menu when a link is clicked */

    mobileMenu.querySelectorAll("a").forEach(link => {

        link.addEventListener("click", () => {

            mobileMenu.classList.remove("show");

            const icon = menuBtn.querySelector("i");

            icon.classList.remove("fa-xmark");
            icon.classList.add("fa-bars");

        });

    });

}


/* ================= CURRENT YEAR ================= */

const yearElement = document.getElementById("year");

if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
}


/* ================= CLOSE MENU WHEN CLICKING OUTSIDE ================= */

document.addEventListener("click", (event) => {

    if (!menuBtn || !mobileMenu) return;

    if (
        mobileMenu.classList.contains("show") &&
        !mobileMenu.contains(event.target) &&
        !menuBtn.contains(event.target)
    ) {

        mobileMenu.classList.remove("show");

        const icon = menuBtn.querySelector("i");

        icon.classList.remove("fa-xmark");
        icon.classList.add("fa-bars");

    }

});
