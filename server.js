const express = require("express");
const session = require("express-session");
const multer = require("multer");
const { google } = require("googleapis");
const fs = require("fs");
require("dotenv").config();

const app = express();
const PORT = 3000;
const upload = multer({ dest: "uploads/" });

const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
);

const slidesAPI = google.slides({ version: "v1", auth: oauth2Client });
const drive = google.drive({ version: "v3", auth: oauth2Client });

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true
}));

app.use(express.json());
app.use(express.static("public"));

// 🔹 Google Login
app.get("/auth", (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: ["https://www.googleapis.com/auth/presentations", "https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/drive.readonly"]
    });
    res.redirect(authUrl);
});

// 🔹 OAuth Callback
app.get("/auth/callback", async (req, res) => {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    req.session.tokens = tokens;
    res.redirect("/templates.html");
});

app.get("/slides", async (req, res) => {
    try {
        const { presentationId } = req.query;
        if (!presentationId) {
            return res.status(400).json({ error: "Missing presentationId" });
        }

        const slidesService = google.slides({ version: "v1", auth: oauth2Client });
        const presentation = await slidesService.presentations.get({ presentationId });

        const slides = presentation.data.slides.map(slide => {
            const background = slide.pageProperties?.pageBackgroundFill?.solidFill?.color?.rgbColor || { red: 1, green: 1, blue: 1 };

            return {
                slideId: slide.objectId,
                backgroundColor: background,
                elements: slide.pageElements.map(element => ({
                    id: element.objectId,
                    type: element.shape ? "text" : "unknown",
                    text: element.shape?.text?.textElements?.map(t => t.textRun?.content).join("") || "",
                    textColor: element.shape?.text?.textStyle?.foregroundColor?.color?.rgbColor || null
                }))
            };
        });

        res.json({ slides });
    } catch (error) {
        console.error("❌ Error fetching slides:", error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});







app.post("/api/update-slide-background", async (req, res) => {
    try {
        const { slideId, color, presentationId } = req.body;
        if (!color || !presentationId) {
            return res.status(400).json({ error: "Missing color or presentationId" });
        }

        const slidesService = google.slides({ version: "v1", auth: oauth2Client });

        // Convert hex color to RGB
        const hexToRgb = (hex) => {
            const bigint = parseInt(hex.slice(1), 16);
            return {
                red: ((bigint >> 16) & 255) / 255,
                green: ((bigint >> 8) & 255) / 255,
                blue: (bigint & 255) / 255
            };
        };

        const rgbColor = hexToRgb(color);

        let slideIds = [];
        
        // If no slideId is given, fetch all slides from the presentation
        if (!slideId) {
            const presentation = await slidesService.presentations.get({ presentationId });
            slideIds = presentation.data.slides.map((slide) => slide.objectId);
        } else {
            slideIds = [slideId]; // Apply only to the given slide
        }

        // Create batch update requests
        const updateRequests = slideIds.map((id) => ({
            updatePageProperties: {
                objectId: id,
                pageProperties: {
                    pageBackgroundFill: {
                        solidFill: {
                            color: { rgbColor }
                        }
                    }
                },
                fields: "pageBackgroundFill.solidFill.color"
            }
        }));

        await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: updateRequests }
        });

        res.json({ success: true, message: `Background updated for ${slideIds.length} slide(s).` });
    } catch (error) {
        console.error("❌ Error updating slide background:", error);
        res.status(500).json({ error: "Failed to update background", details: error.message });
    }
});







// 🔹 Upload Image to Google Drive
app.post("/upload-image", upload.single("image"), async (req, res) => {
    try {
        const fileMetadata = {
            name: req.file.originalname,
            parents: [process.env.DRIVE_FOLDER_ID] // Make sure this ID is correct
        };
        const media = {
            mimeType: req.file.mimetype,
            body: fs.createReadStream(req.file.path)
        };

        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: "id"
        });

        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: { role: "reader", type: "anyone" }
        });

        const imageUrl = `https://drive.google.com/uc?id=${file.data.id}`;
        fs.unlinkSync(req.file.path);

        res.json({ imageUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/templates", async (req, res) => {
    if (!req.session.tokens) return res.status(401).json({ error: "Login Required" });

    oauth2Client.setCredentials(req.session.tokens);

    try {
        const response = await drive.files.list({
            q: `'${process.env.TEMPLATES_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.presentation'`,
            fields: "files(id, name, thumbnailLink)"
        });
console.log('abcd',process.env.TEMPLATES_FOLDER_ID);
        console.log("✅ API Response:", response.data); // Add this log

        if (!response.data.files || response.data.files.length === 0) {
            console.log("❌ No gg found");
            return res.status(404).json({ error: "No templates found" });
        }

        res.json({ templates: response.data.files });
    } catch (error) {
        console.error("❌ Error fetching templates:", error);
        res.status(500).json({ error: error.message });
    }
});


// 🔹 Duplicate a Template and Create a New Presentation
app.post("/create-presentation", async (req, res) => {
    if (!req.session.tokens) return res.status(401).json({ error: "Login Required" });

    oauth2Client.setCredentials(req.session.tokens);
    
    const { templateId } = req.body;

    const uniqueName = `Pre_${Date.now()}`;

    const folderId = "13uBctjwxABUnP8hrdOCvezqgHEaOl8Tp"; // Replace with your target folder ID
    
    try {
        const response = await drive.files.copy({
            fileId: templateId,
            requestBody: { name: uniqueName,parents: [folderId] },
        });

        res.json({ newPresentationId: response.data.id,redirectUrl: `/editor.html?presentationId=${response.data.id}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.post("/update", async (req, res) => {
    if (!req.session.tokens) {
        return res.status(401).json({ error: "Login Required" });
    }

    oauth2Client.setCredentials(req.session.tokens);
    const { updates } = req.body;
    const presentationId = req.query.presentationId || process.env.PRESENTATION_ID;

    try {
        const requests = updates.map(update => ({
            replaceAllText: {
                containsText: { text: "{{PLACEHOLDER}}", matchCase: false }, // Match text
                replaceText: update.text,
            }
        }));

        await slidesAPI.presentations.batchUpdate({
            presentationId,
            requestBody: { requests }
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Error updating slides:", error);
        res.status(500).json({ error: error.message });
    }
});


app.post("/api/update-slide", async (req, res) => {
    try {
        const { presentationId, slideObjectId, newText } = req.body;

        if (!presentationId || !slideObjectId || !newText) {
            return res.status(400).json({ error: "Missing required fields" });
        }

      
      //  const authClient = await auth.getClient();
        const slides = google.slides({ version: "v1", auth: oauth2Client });

        const requests = [
            {
                deleteText: {
                    objectId: slideObjectId,
                    textRange: {
                        type: "ALL", // Removes all text inside the element
                    },
                },
            },
            {
                insertText: {
                    objectId: slideObjectId,
                    text: newText, // Inserts the new text after deletion
                },
            },
        ];

        const response = await slides.presentations.batchUpdate({
            presentationId,
            requestBody: { requests },
        });

        res.json({ success: true, message: "Slide updated successfully", response: response.data });
    } catch (error) {
        console.error("❌ Error updating slide:", error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});




app.post("/api/update-slide-text", async (req, res) => {
    try {
        const { presentationId, slideObjectId, newText } = req.body;

        if (!presentationId || !slideObjectId || !newText) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const slides = google.slides({ version: "v1", auth: oauth2Client });

        const requests = [
            {
                deleteText: {
                    objectId: slideObjectId,
                    textRange: { type: "ALL" }, // Removes all text inside the element
                },
            },
            {
                insertText: {
                    objectId: slideObjectId,
                    text: newText, // Inserts new text
                },
            },
        ];

        const response = await slides.presentations.batchUpdate({
            presentationId,
            requestBody: { requests },
        });

        res.json({ success: true, message: "Slide updated successfully", response: response.data });
    } catch (error) {
        console.error("❌ Error updating slide:", error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});


app.post("/api/update-slide2", async (req, res) => {
    try {
        const { presentationId, slideId, newText, fontSize, isBold, isItalic, isUnderline, alignment } = req.body;

        if (!presentationId || !slideId) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const slides = google.slides({ version: "v1", auth: oauth2Client });

        // ✅ Get slide elements
        const slideData = await slides.presentations.pages.get({
            presentationId,
            pageObjectId: slideId,
        });

        let textBoxId = null;
        let existingText = null;

        // ✅ Find a valid text box with text
        for (const element of slideData.data.pageElements) {
            if (element.shape?.text?.textElements) {
                const textElements = element.shape.text.textElements;
                for (const textElement of textElements) {
                    if (textElement.textRun?.content?.trim()) {
                        textBoxId = element.objectId;
                        existingText = textElement.textRun.content.trim();
                        break;
                    }
                }
            }
            if (textBoxId && existingText) break;
        }

        if (!textBoxId || !existingText) {
            return res.status(400).json({ error: "No text box with text found in the slide." });
        }

        console.log("✅ Found Text Box ID:", textBoxId);
        console.log("📢 Existing Text:", existingText);

        let requests = [];

        // ✅ Replace the first existing text in the slide
        requests.push({
            replaceAllText: {
                containsText: { text: existingText, matchCase: false },
                replaceText: newText,
            },
        });

        // ✅ Check if newText is not empty before applying text styles
        if (newText.trim() !== "") {
            requests.push({
                updateTextStyle: {
                    objectId: textBoxId,
                    textRange: { type: "ALL" },
                    style: {
                        fontSize: { magnitude: fontSize || 16, unit: "PT" },
                        bold: isBold || false,
                        italic: isItalic || false,
                        underline: isUnderline || false,
                    },
                    fields: "fontSize,bold,italic,underline",
                },
            });

            // ✅ Update text alignment only if text exists
            requests.push({
                updateParagraphStyle: {
                    objectId: textBoxId,
                    textRange: { type: "ALL" },
                    style: { alignment: alignment ? alignment.toUpperCase() : "CENTER" },
                    fields: "alignment",
                },
            });
        } else {
            console.warn("⚠️ Skipping text style update because newText is empty.");
        }

        // ✅ Send request to Google Slides API
        const response = await slides.presentations.batchUpdate({
            presentationId,
            requestBody: { requests },
        });

        console.log("📢 Google Slides API Response:", response.data);

        res.json({ success: true, message: "Slide updated successfully", response: response.data });
    } catch (error) {
        console.error("❌ Error updating slide:", error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

















async function createPresentation(slides) {
    const slidesService = google.slides({ version: "v1", auth: oauth2Client });

    // Create a new presentation
    const presentation = await slidesService.presentations.create({
        requestBody: { title: "Generated Presentation" }
    });

    const presentationId = presentation.data.presentationId;
    console.log("Presentation created with ID:", presentationId);

    // Fetch the presentation data
    const presentationData = await slidesService.presentations.get({ presentationId });
    let slideList = presentationData.data.slides;
    console.log("Existing Slides:", slideList.map(s => s.objectId));

    if (slideList.length > 0 && slides.length > 0) {
        const firstSlideId = slideList[0].objectId;
        console.log("Modifying first slide:", firstSlideId);

        // **Create a new slide with TITLE_AND_BODY layout**
        const newSlideResponse = await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: {
                requests: [
                    {
                        createSlide: {
                            slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" }
                        }
                    }
                ]
            }
        });

        const newSlideId = newSlideResponse.data.replies[0]?.createSlide?.objectId;
        console.log("New first slide created with ID:", newSlideId);

        // Fetch updated slide list
        const updatedPresentationData = await slidesService.presentations.get({ presentationId });
        const newSlide = updatedPresentationData.data.slides.find(s => s.objectId === newSlideId);

        let titlePlaceholder, bodyPlaceholder;

        newSlide.pageElements.forEach(element => {
            console.log("Element found:", element.shape?.shapeType, element.objectId);

            if (element.shape?.placeholder?.type === "TITLE") {
                titlePlaceholder = element.objectId;
            }
            if (element.shape?.placeholder?.type === "BODY") {
                bodyPlaceholder = element.objectId;
            }
        });

        console.log("Title Placeholder for New First Slide:", titlePlaceholder);
        console.log("Body Placeholder for New First Slide:", bodyPlaceholder);

        const firstSlideRequests = [];

        if (titlePlaceholder) {
            firstSlideRequests.push({
                insertText: {
                    objectId: titlePlaceholder,
                    text: slides[0].title,
                    insertionIndex: 0
                }
            });
        }

        if (bodyPlaceholder) {
            firstSlideRequests.push({
                insertText: {
                    objectId: bodyPlaceholder,
                    text: slides[0].body.join("\n"),
                    insertionIndex: 0
                }
            });
        }

        if (firstSlideRequests.length > 0) {
            await slidesService.presentations.batchUpdate({
                presentationId,
                requestBody: { requests: firstSlideRequests }
            });
            console.log("✅ First Slide Updated!");
        } else {
            console.error("⚠ No placeholders found for the first slide.");
        }

        // **(Optional) Delete the original first slide**
        await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: {
                requests: [
                    {
                        deleteObject: {
                            objectId: firstSlideId
                        }
                    }
                ]
            }
        });
        console.log("🗑️ Deleted the default first slide.");
    }

    // Now, create the remaining slides as usual
    for (let i = 1; i < slides.length; i++) {
        const slide = slides[i];

        // Create a new slide
        const slideResponse = await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: {
                requests: [
                    {
                        createSlide: {
                            slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" }
                        }
                    }
                ]
            }
        });

        const slideObjectId = slideResponse.data.replies[0]?.createSlide?.objectId;
        console.log(`Slide ${i + 1} created with ID:`, slideObjectId);

        // Fetch slide data to find placeholders
        const updatedPresentationData = await slidesService.presentations.get({ presentationId });
        const slideData = updatedPresentationData.data.slides.find(s => s.objectId === slideObjectId);

        if (!slideData) {
            console.error(`Slide ${i + 1} not found!`);
            continue;
        }

        let titlePlaceholder, bodyPlaceholder;

        slideData.pageElements.forEach(element => {
            console.log("Element found:", element.shape?.shapeType, element.objectId);

            if (element.shape?.placeholder?.type === "TITLE") {
                titlePlaceholder = element.objectId;
            }
            if (element.shape?.placeholder?.type === "BODY") {
                bodyPlaceholder = element.objectId;
            }
        });

        console.log(`Title Placeholder for Slide ${i + 1}:`, titlePlaceholder);
        console.log(`Body Placeholder for Slide ${i + 1}:`, bodyPlaceholder);

        const requests = [];

        if (titlePlaceholder) {
            requests.push({
                insertText: {
                    objectId: titlePlaceholder,
                    text: slide.title,
                    insertionIndex: 0
                }
            });
        }

        if (bodyPlaceholder) {
            requests.push({
                insertText: {
                    objectId: bodyPlaceholder,
                    text: slide.body.join("\n"),
                    insertionIndex: 0
                }
            });
        }

        if (requests.length > 0) {
            await slidesService.presentations.batchUpdate({
                presentationId,
                requestBody: { requests }
            });
            console.log(`✅ Slide ${i + 1} Updated!`);
        } else {
            console.error(`⚠ No placeholders found for Slide ${i + 1}.`);
        }
    }

    return presentationId;
}


app.post("/api/save-slides", async (req, res) => {
    try {
        const slides = req.body.slides;
        const presentationId = await createPresentation(slides);
        res.json({ "presentationId":presentationId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to save slides" });
    }
});




app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
