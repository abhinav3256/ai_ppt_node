let selectedImageId = null;

async function loadSlides() {
    const response = await fetch("/slides");
    const data = await response.json();

    if (data.error) {
        document.getElementById("slidesContainer").innerHTML = `<h2>${data.error}</h2>`;
        return;
    }

    // const urlParams = new URLSearchParams(window.location.search);
    // const presentationId = urlParams.get("presentationId");
    const queryString = document.location.search;
    const urlParams = new URLSearchParams(queryString);
    const presentationId = urlParams.get("presentationId");

    if (!presentationId) {
         presentationId = process.env.PRESENTATION_ID;

    }

    document.getElementById("slidesIframe").src = `https://docs.google.com/presentation/d/${presentationId}/embed`;

    const slidesContainer = document.getElementById("slidesContainer");
    slidesContainer.innerHTML = "";

    data.slides.forEach(slide => {
        const slideDiv = document.createElement("div");
        slideDiv.classList.add("slide");

        slide.elements.forEach(el => {
            if (el.text) {
                const textDiv = document.createElement("div");
                textDiv.textContent = el.text.trim();
                textDiv.setAttribute("data-id", el.id);
                textDiv.setAttribute("contenteditable", "true");
                slideDiv.appendChild(textDiv);
            }

            if (el.image) {
                const img = document.createElement("img");
                img.src = el.image;
                img.setAttribute("data-id", el.id);
                img.addEventListener("click", () => selectImage(img));
                slideDiv.appendChild(img);
            }
        });

        slidesContainer.appendChild(slideDiv);
    });
}

function selectImage(imgElement) {
    selectedImageId = imgElement.getAttribute("data-id");
    document.getElementById("imageUpload").click();
}

document.getElementById("imageUpload").addEventListener("change", async (event) => {
    if (!selectedImageId || !event.target.files.length) return;

    const file = event.target.files[0];
    const formData = new FormData();
    formData.append("image", file);

    // Upload image to server
    const response = await fetch("/upload-image", {
        method: "POST",
        body: formData
    });

    const result = await response.json();
    if (result.error) {
        alert("❌ Image upload failed");
        return;
    }

    // Update image preview
    document.querySelector(`[data-id="${selectedImageId}"]`).src = result.imageUrl;
});

// async function saveChanges() {
//     const elements = document.querySelectorAll("[contenteditable='true']");
//     const updates = [];

//     elements.forEach(el => {
//         updates.push({
//             objectId: el.getAttribute("data-id"),
//             text: el.textContent
//         });
//     });

//     await fetch("/update", {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({ updates })
//     });

//     alert("✅ Changes saved successfully!");
// }


async function saveChanges() {
    const elements = document.querySelectorAll("[contenteditable='true']");
    const updates = [];

    elements.forEach(el => {
        updates.push({
            objectId: el.getAttribute("data-id"),
            text: el.textContent.trim()
        });
    });

    if (updates.length === 0) {
        alert("⚠️ No changes detected!");
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    let presentationId = urlParams.get("presentationId") || process.env.PRESENTATION_ID;

    try {
        const response = await fetch(`/update?presentationId=${presentationId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ updates })
        });

        const result = await response.json();

        if (result.success) {
            alert("✅ Changes saved successfully! Refreshing...");
            setTimeout(() => location.reload(), 1000); // Refresh to see changes
        } else {
            throw new Error(result.error || "Unknown error occurred");
        }
    } catch (error) {
        console.error("❌ Error:", error);
        alert(`❌ Error saving changes: ${error.message}`);
    }
}



loadSlides();
